/**
 * LINE Messaging API adapter.
 *
 * - `X-Line-Signature` is the base64 HMAC-SHA256 of the raw body, keyed with the
 *   channel secret. The console's "Verify" button posts `{"events": []}` signed
 *   the same way, so an empty batch is answered 200 after the check.
 * - Each event carries `webhookEventId` (the dedupe key — a redelivery reuses it)
 *   and a `timestamp` in ms.
 * - A reply token is single-use and only guaranteed for about a minute, which a
 *   model run can outlast; replies therefore try the (free) reply endpoint first
 *   and fall back to a push, made idempotent with `X-Line-Retry-Key`.
 * @see https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
 * @see https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects
 * @see https://developers.line.biz/en/reference/messaging-api/#send-reply-message
 * @see https://developers.line.biz/en/reference/messaging-api/#send-push-message
 * @see https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
 */
import { FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";
import { bytesToBase64, hmacSha256, timingSafeEqual } from "../../lib/crypto";
import type { AttachmentKind, DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

const LINE_API = "https://api.line.me/v2/bot/message";
/** Message content is served from the data host, not the API host. */
const LINE_DATA_API = "https://api-data.line.me/v2/bot/message";
/** An image message's preview may be at most 1 MB; LINE fetches both URLs itself. */
const LINE_PREVIEW_MAX_BYTES = 1024 * 1024;
const LINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);
const LINE_MEDIA_KINDS: Readonly<Record<string, AttachmentKind>> = { audio: "voice", file: "file", image: "image" };
const LINE_TEXT_MAX = 5000;
/** The reply and push endpoints both take at most five message objects. */
const LINE_MAX_MESSAGES = 5;

/**
 * How old an event may be and still be answered. LINE stops redelivering after
 * 20 minutes; anything older than this is a replay, not a redelivery.
 */
export const LINE_EVENT_MAX_AGE_MS = 30 * 60 * 1000;

export const validateLineSignature = async (signatureHeader: string | null, rawBody: string, channelSecret: string): Promise<boolean> => {
    if (!signatureHeader) {
        return false;
    }

    return timingSafeEqual(signatureHeader, bytesToBase64(await hmacSha256(channelSecret, rawBody)));
};

export interface LineInboundMessage extends InboundMessage {
    replyToken?: string;
}

interface LineEvent {
    message?: {
        /** `external`: the content lives at the sender's own URL, which we do not fetch. */
        contentProvider?: { type?: string };
        fileName?: string;
        fileSize?: number;
        id?: string;
        text?: string;
        type?: string;
    };
    mode?: string;
    replyToken?: string;
    source?: { groupId?: string; roomId?: string; type?: string; userId?: string };
    timestamp?: number;
    type?: string;
    webhookEventId?: string;
}

/**
 * Message events from users. Follows, joins, postbacks and events received while
 * the channel is in `standby` mode (another module owns the chat) are skipped.
 */
export const parseLineWebhook = (body: unknown): LineInboundMessage[] => {
    const events = (body as { events?: LineEvent[] } | null)?.events;

    if (!Array.isArray(events)) {
        return [];
    }

    const messages: LineInboundMessage[] = [];

    for (const event of events) {
        const userId = event.source?.userId;

        if (event.type !== "message" || event.mode === "standby" || !userId || !event.webhookEventId || !event.message) {
            continue;
        }

        const chatId = event.source?.groupId ?? event.source?.roomId ?? userId;
        const text = event.message.type === "text" ? event.message.text : undefined;
        const kind = LINE_MEDIA_KINDS[event.message.type ?? ""];
        // LINE's audio messages are what its app records — voice notes.
        const attachments: InboundAttachment[] =
            kind && event.message.id && event.message.contentProvider?.type !== "external"
                ? [{ kind, name: event.message.fileName, ref: event.message.id, ...(event.message.fileSize !== undefined && { size: event.message.fileSize }) }]
                : [];

        messages.push({
            ...(attachments.length > 0 && { attachments }),
            chatId,
            eventId: event.webhookEventId,
            kind: inboundKind(text, attachments),
            replyToken: event.replyToken,
            senderId: userId,
            text,
            timestampMs: event.timestamp ?? NaN,
        });
    }

    return messages;
};

const toLineMessages = (text: string): { text: string; type: "text" }[] =>
    splitMessage(text, LINE_TEXT_MAX)
        .slice(0, LINE_MAX_MESSAGES)
        .map((chunk) => {
            return { text: chunk, type: "text" as const };
        });

const postLine = async (path: "push" | "reply", accessToken: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    await fetchWithDeadline(`${LINE_API}/${path}`, {
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...headers },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });

/** Download a message's content (image, audio, file) with the channel access token. */
export const downloadLineContent = async (accessToken: string, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    const content = await fetchMedia(`${LINE_DATA_API}/${encodeURIComponent(attachment.ref)}/content`, {
        allowedHosts: ["api-data.line.me"],
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Audio LINE is still transcoding answers 202 with no body.
    if (content.bytes.byteLength === 0) {
        throw new Error("LINE content is not ready");
    }

    return content;
};

/**
 * Send a file as an image message. LINE takes no uploads — it fetches the
 * image from HTTPS URLs itself, so the signed URL is the image — and only
 * JPEG/PNG whose preview fits in 1 MB. Anything else is `"unsupported"`, sent
 * as a link.
 */
export const sendLineMedia = async (accessToken: string, to: string, file: OutboundFile, retryKey: string = crypto.randomUUID()): Promise<MediaSendResult> => {
    if (!LINE_IMAGE_TYPES.has(file.mediaType) || file.bytes.byteLength > LINE_PREVIEW_MAX_BYTES) {
        return "unsupported";
    }

    const push = await postLine(
        "push",
        accessToken,
        { messages: [{ originalContentUrl: file.url, previewImageUrl: file.url, type: "image" }], to },
        { "X-Line-Retry-Key": retryKey },
    );

    await push.body?.cancel();

    if (!push.ok && push.status !== 409) {
        throw new Error(`LINE push failed: ${String(push.status)} ${push.statusText}`);
    }

    return "sent";
};

/**
 * Reply with the token when there is one, else (or when it has expired) push.
 * A 409 on the push means LINE already accepted this retry key — success.
 */
export const sendLineMessage = async (
    accessToken: string,
    to: string,
    text: string,
    replyToken?: string,
    retryKey: string = crypto.randomUUID(),
): Promise<void> => {
    const messages = toLineMessages(text);

    if (replyToken) {
        const reply = await postLine("reply", accessToken, { messages, replyToken });

        await reply.body?.cancel();

        if (reply.ok) {
            return;
        }
    }

    const push = await postLine("push", accessToken, { messages, to }, { "X-Line-Retry-Key": retryKey });

    await push.body?.cancel();

    if (!push.ok && push.status !== 409) {
        throw new Error(`LINE push failed: ${String(push.status)} ${push.statusText}`);
    }
};
