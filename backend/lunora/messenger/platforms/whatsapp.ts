/**
 * WhatsApp Business (Meta Cloud API) adapter.
 *
 * - Endpoint verification is a GET handshake: `hub.mode=subscribe`, the
 *   `hub.verify_token` the user typed into the App Dashboard, and a
 *   `hub.challenge` we echo back.
 * - Every POST carries `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw
 *   body, keyed with the App Secret>`. The signature covers no timestamp, so
 *   replay protection is the message's own `timestamp` plus dedupe on its `wamid`.
 * - Free-form replies are only allowed inside the 24-hour customer service
 *   window opened by the customer's last message; outside it Meta accepts only
 *   pre-approved templates and answers error 131047.
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_SHORT_MS, fetchOk, fetchWithDeadline } from "../../lib/fetch-timeout";
import { bytesToHex, hmacSha256, timingSafeEqual } from "../../lib/crypto";
import type { DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia, MediaDownloadError, MESSENGER_MEDIA_MAX_BYTES, toBlob } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

const GRAPH_API = "https://graph.facebook.com";

/** Where Meta serves a media URL from (`lookaside.fbsbx.com` today); the access token goes nowhere else. */
const WHATSAPP_MEDIA_HOSTS = [".fbsbx.com", ".fbcdn.net", ".whatsapp.net"];

/** Images WhatsApp shows inline; every other file goes as a document. */
const WHATSAPP_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);
const WHATSAPP_AUDIO_TYPES: ReadonlySet<string> = new Set(["audio/aac", "audio/amr", "audio/mp4", "audio/mpeg", "audio/ogg"]);

export const WHATSAPP_GRAPH_VERSION = "v25.0";

/** The customer service window: free-form replies only within 24h of the customer's last message. */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Graph error code for "more than 24 hours have passed since the customer last replied". */
export const WHATSAPP_WINDOW_CLOSED_ERROR = 131_047;

const WHATSAPP_TEXT_MAX = 4096;

/**
 * Answer Meta's subscription handshake. Returns the challenge to echo, or null
 * when the mode or token is wrong.
 */
export const verifyWhatsAppSubscription = (url: URL, verifyToken: string): string | null => {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !token || !challenge || !timingSafeEqual(token, verifyToken)) {
        return null;
    }

    return challenge;
};

/** Verify `X-Hub-Signature-256` against the raw request body. */
export const validateWhatsAppSignature = async (signatureHeader: string | null, rawBody: string, appSecret: string): Promise<boolean> => {
    if (!signatureHeader?.startsWith("sha256=")) {
        return false;
    }

    const expected = `sha256=${bytesToHex(await hmacSha256(appSecret, rawBody))}`;

    return timingSafeEqual(signatureHeader.toLowerCase(), expected);
};

interface WhatsAppMedia {
    caption?: string;
    id?: string;
    mime_type?: string;
}

type WhatsAppMessage = NonNullable<
    NonNullable<NonNullable<NonNullable<WhatsAppWebhookPayload["entry"]>[number]["changes"]>[number]["value"]>["messages"]
>[number];

/** The media of an `image`, `document` or `audio` message (voice notes are `audio` with `voice: true`), and its caption. */
const whatsAppMedia = (message: WhatsAppMessage): { attachments: InboundAttachment[]; caption?: string } => {
    if (message.type === "image" && message.image?.id) {
        return { attachments: [{ kind: "image", mimeType: message.image.mime_type, ref: message.image.id }], caption: message.image.caption };
    }

    if (message.type === "document" && message.document?.id) {
        return {
            attachments: [{ kind: "file", mimeType: message.document.mime_type, name: message.document.filename, ref: message.document.id }],
            caption: message.document.caption,
        };
    }

    if (message.type === "audio" && message.audio?.id) {
        return { attachments: [{ kind: message.audio.voice ? "voice" : "audio", mimeType: message.audio.mime_type, ref: message.audio.id }] };
    }

    return { attachments: [] };
};

interface WhatsAppWebhookPayload {
    entry?: {
        changes?: {
            field?: string;
            value?: {
                contacts?: { profile?: { name?: string }; wa_id?: string }[];
                messages?: {
                    audio?: WhatsAppMedia & { voice?: boolean };
                    document?: WhatsAppMedia & { filename?: string };
                    from?: string;
                    id?: string;
                    image?: WhatsAppMedia;
                    text?: { body?: string };
                    timestamp?: string;
                    type?: string;
                }[];
                metadata?: { phone_number_id?: string };
            };
        }[];
    }[];
    object?: string;
}

/**
 * Pull the customer messages out of a webhook body. Status updates (sent,
 * delivered, read) carry no `messages` and yield nothing. Messages addressed to
 * a different phone number id than the configured one are dropped: one Meta app
 * can serve several numbers, and only this connection's number is ours to answer.
 */
export const parseWhatsAppWebhook = (body: unknown, phoneNumberId: string): InboundMessage[] => {
    const payload = body as WhatsAppWebhookPayload;

    if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
        return [];
    }

    const messages: InboundMessage[] = [];

    for (const entry of payload.entry) {
        const changes = entry.changes ?? [];

        for (const change of changes) {
            const { value } = change;

            if (change.field !== "messages" || !value?.messages || value.metadata?.phone_number_id !== phoneNumberId) {
                continue;
            }

            for (const message of value.messages) {
                if (!message.from || !message.id || !message.timestamp) {
                    continue;
                }

                const contact = value.contacts?.find((candidate) => candidate.wa_id === message.from);
                const { attachments, caption } = whatsAppMedia(message);
                const text = message.type === "text" ? message.text?.body : caption;

                messages.push({
                    ...(attachments.length > 0 && { attachments }),
                    chatId: message.from,
                    eventId: message.id,
                    kind: inboundKind(text, attachments),
                    senderId: message.from,
                    senderName: contact?.profile?.name,
                    text,
                    timestampMs: Number(message.timestamp) * 1000,
                });
            }
        }
    }

    return messages;
};

/** Whether a free-form reply to a message sent at `lastInboundMs` is still allowed. */
export const isWhatsAppWindowOpen = (lastInboundMs: number, nowMs: number = Date.now()): boolean =>
    Number.isFinite(lastInboundMs) && nowMs - lastInboundMs < WHATSAPP_SERVICE_WINDOW_MS;

export type WhatsAppSendResult = "sent" | "window_closed";

/**
 * POST one message. Resolves `"window_closed"` when Meta refuses with 131047
 * (the caller explains that in the thread); any other failure throws.
 */
const postWhatsAppMessage = async (accessToken: string, phoneNumberId: string, payload: Record<string, unknown>): Promise<WhatsAppSendResult> => {
    const response = await fetchWithDeadline(`${GRAPH_API}/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });

    if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;

        if (error?.error?.code === WHATSAPP_WINDOW_CLOSED_ERROR) {
            return "window_closed";
        }

        throw new Error(`WhatsApp send failed: ${String(response.status)} ${error?.error?.message ?? response.statusText}`);
    }

    await response.body?.cancel();

    return "sent";
};

/** Send a text reply, split to WhatsApp's limit. */
export const sendWhatsAppMessage = async (accessToken: string, phoneNumberId: string, to: string, text: string): Promise<WhatsAppSendResult> => {
    for (const chunk of splitMessage(text, WHATSAPP_TEXT_MAX)) {
        if ((await postWhatsAppMessage(accessToken, phoneNumberId, { text: { body: chunk, preview_url: false }, to, type: "text" })) === "window_closed") {
            return "window_closed";
        }
    }

    return "sent";
};

/**
 * Download a media message: the Graph API resolves the media id to a
 * short-lived URL, which takes the same access token — sent only to Meta's own
 * media hosts.
 */
export const downloadWhatsAppMedia = async (accessToken: string, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    const response = await fetchOk(`${GRAPH_API}/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(attachment.ref)}`, {
        errorPrefix: "WhatsApp media lookup failed",
        headers: { Authorization: `Bearer ${accessToken}` },
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const media = (await response.json()) as { file_size?: number; url?: string };

    if (!media.url) {
        throw new MediaDownloadError("failed", "WhatsApp media lookup returned no URL");
    }

    if ((media.file_size ?? 0) > MESSENGER_MEDIA_MAX_BYTES) {
        throw new MediaDownloadError("too-large", "WhatsApp media is over the size limit");
    }

    return await fetchMedia(media.url, { allowedHosts: WHATSAPP_MEDIA_HOSTS, headers: { Authorization: `Bearer ${accessToken}` } });
};

/**
 * Upload a file to the number's media store, then send it by id: JPEG/PNG as
 * an image, supported audio as audio, anything else as a document.
 */
export const sendWhatsAppMedia = async (accessToken: string, phoneNumberId: string, to: string, file: OutboundFile): Promise<MediaSendResult> => {
    const form = new FormData();

    form.set("messaging_product", "whatsapp");
    form.set("type", file.mediaType);
    form.set("file", toBlob(file), file.name);

    const uploaded = await fetchOk(`${GRAPH_API}/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/media`, {
        body: form,
        errorPrefix: "WhatsApp media upload failed",
        headers: { Authorization: `Bearer ${accessToken}` },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_LONG_MS,
    });
    const { id } = (await uploaded.json()) as { id?: string };

    if (!id) {
        throw new Error("WhatsApp media upload returned no id");
    }

    if (WHATSAPP_IMAGE_TYPES.has(file.mediaType)) {
        return await postWhatsAppMessage(accessToken, phoneNumberId, { image: { id }, to, type: "image" });
    }

    if (WHATSAPP_AUDIO_TYPES.has(file.mediaType)) {
        return await postWhatsAppMessage(accessToken, phoneNumberId, { audio: { id }, to, type: "audio" });
    }

    return await postWhatsAppMessage(accessToken, phoneNumberId, { document: { filename: file.name, id }, to, type: "document" });
};
