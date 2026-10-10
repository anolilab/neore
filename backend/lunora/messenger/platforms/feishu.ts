/**
 * Feishu / Lark adapter (event subscription v2.0, `im.message.receive_v1`).
 *
 * We REQUIRE an Encrypt Key: without one Feishu neither encrypts nor signs event
 * pushes, and "signature verification is mandatory" would have nothing to check.
 *
 * - Bodies arrive as `{"encrypt": "<base64>"}`: AES-256-CBC, key = SHA-256 of
 *   the Encrypt Key, the first 16 decoded bytes are the IV, PKCS#7 padding.
 * - Event pushes carry `X-Lark-Signature = hex(SHA-256(timestamp + nonce +
 *   encryptKey + rawBody))` plus `X-Lark-Request-Timestamp` (seconds), which we
 *   hold to a five-minute window.
 * - The one-time `url_verification` challenge is encrypted but NOT signed, so it
 *   is accepted on successful decryption plus a constant-time match of its
 *   `token` against the Verification Token — the same token every v2 event
 *   carries in `header.token`, which is checked too.
 * - Replies: a `tenant_access_token` (cached until shortly before it expires)
 *   and `POST /open-apis/im/v1/messages?receive_id_type=chat_id`.
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
 * @see https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_SHORT_MS, fetchOk, fetchWithDeadline } from "../../lib/fetch-timeout";
import { base64ToBytes, digestHex, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, sha256Bytes, timingSafeEqual } from "../../lib/crypto";
import type { DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia, toBlob } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

/** The Feishu upload type of a file message; anything unlisted is a generic `stream`. */
const FEISHU_FILE_TYPES: Readonly<Record<string, string>> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
};

/** Feishu (mainland China) and Lark (international) are the same API on different hosts. */
export const feishuApiBase = (domain: string | undefined): string =>
    domain?.trim().toLowerCase() === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

/** Feishu's text messages are limited to 150 KB of request body; keep chunks comfortably under it. */
const FEISHU_TEXT_MAX = 10_000;

export const decryptFeishuPayload = async (encrypted: string, encryptKey: string): Promise<unknown> => {
    const bytes = base64ToBytes(encrypted);

    if (bytes.length < 32) {
        throw new Error("Feishu payload too short");
    }

    const key = await crypto.subtle.importKey("raw", (await sha256Bytes(encryptKey)) as BufferSource, { name: "AES-CBC" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ iv: bytes.slice(0, 16), name: "AES-CBC" }, key, bytes.slice(16));

    return JSON.parse(new TextDecoder().decode(plaintext));
};

export const validateFeishuSignature = async (headers: Headers, rawBody: string, encryptKey: string, nowMs: number = Date.now()): Promise<boolean> => {
    const signature = headers.get("x-lark-signature");
    const timestamp = headers.get("x-lark-request-timestamp");
    const nonce = headers.get("x-lark-request-nonce");

    if (!signature || !timestamp || nonce === null) {
        return false;
    }

    if (!isWithinWindow(Number(timestamp) * 1000, SIGNED_REQUEST_WINDOW_MS, nowMs)) {
        return false;
    }

    return timingSafeEqual(signature.toLowerCase(), await digestHex("SHA-256", timestamp + nonce + encryptKey + rawBody));
};

interface FeishuEnvelope {
    challenge?: string;
    event?: {
        message?: { chat_id?: string; content?: string; create_time?: string; message_id?: string; message_type?: string };
        sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    };
    header?: { create_time?: string; event_id?: string; event_type?: string; token?: string };
    token?: string;
    type?: string;
}

/**
 * The resource of an `image`, `file` or `audio` message. Its bytes are fetched
 * later by message id and key (`downloadFeishuResource`). Video (`media`),
 * stickers and rich posts are not read.
 */
const feishuAttachments = (type: string | undefined, content: string | undefined, messageId: string): InboundAttachment[] => {
    let parsed: { file_key?: unknown; file_name?: unknown; image_key?: unknown };

    try {
        parsed = JSON.parse(content ?? "") as typeof parsed;
    } catch {
        return [];
    }

    if (type === "image" && typeof parsed.image_key === "string") {
        return [{ kind: "image", messageId, ref: parsed.image_key }];
    }

    if (type === "file" && typeof parsed.file_key === "string") {
        return [{ kind: "file", messageId, name: typeof parsed.file_name === "string" ? parsed.file_name : undefined, ref: parsed.file_key }];
    }

    // Feishu records voice messages as Opus in an Ogg container.
    if (type === "audio" && typeof parsed.file_key === "string") {
        return [{ kind: "voice", messageId, mimeType: "audio/ogg", ref: parsed.file_key }];
    }

    return [];
};

export type FeishuParseResult = { challenge: string; kind: "challenge" } | { kind: "ignored" } | { kind: "message"; message: InboundMessage };

/**
 * Classify a DECRYPTED envelope. `verificationToken` gates both the challenge
 * and events, so a body encrypted with a leaked key but the wrong token is refused.
 * Returns null when the token does not match.
 */
export const parseFeishuEnvelope = (decrypted: unknown, verificationToken: string): FeishuParseResult | null => {
    const envelope = decrypted as FeishuEnvelope | null;

    if (!envelope || typeof envelope !== "object") {
        return null;
    }

    if (envelope.type === "url_verification") {
        if (!envelope.token || !envelope.challenge || !timingSafeEqual(envelope.token, verificationToken)) {
            return null;
        }

        return { challenge: envelope.challenge, kind: "challenge" };
    }

    if (!envelope.header?.token || !timingSafeEqual(envelope.header.token, verificationToken)) {
        return null;
    }

    const message = envelope.event?.message;
    const senderId = envelope.event?.sender?.sender_id?.open_id;

    if (envelope.header.event_type !== "im.message.receive_v1" || envelope.event?.sender?.sender_type !== "user" || !message?.chat_id || !senderId) {
        return { kind: "ignored" };
    }

    let text: string | undefined;
    const attachments = message.message_id ? feishuAttachments(message.message_type, message.content, message.message_id) : [];

    if (message.message_type === "text" && message.content) {
        try {
            // Group @-mentions arrive as `@_user_1` placeholders; drop them.
            text = String((JSON.parse(message.content) as { text?: unknown }).text ?? "")
                .replaceAll(/@_user_\d+/g, "")
                .trim();
        } catch {
            text = undefined;
        }
    }

    return {
        kind: "message",
        message: {
            ...(attachments.length > 0 && { attachments }),
            chatId: message.chat_id,
            eventId: envelope.header.event_id ?? message.message_id ?? "",
            kind: inboundKind(text, attachments),
            senderId,
            text: text || undefined,
            timestampMs: Number(message.create_time ?? envelope.header.create_time),
        },
    };
};

const tenantTokenCache = new Map<string, { expiresAt: number; token: string }>();

/** Forget cached tenant tokens for an app (account deletion). */
export const forgetFeishuTokens = (appId: string): void => {
    for (const cacheKey of tenantTokenCache.keys()) {
        if (cacheKey.endsWith(`|${appId}`)) {
            tenantTokenCache.delete(cacheKey);
        }
    }
};

const getTenantAccessToken = async (base: string, appId: string, appSecret: string): Promise<string> => {
    const cacheKey = `${base}|${appId}`;
    const cached = tenantTokenCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.token;
    }

    const response = await fetchOk(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        errorPrefix: "Feishu token request failed",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json()) as { code?: number; expire?: number; msg?: string; tenant_access_token?: string };

    if (result.code !== 0 || !result.tenant_access_token) {
        throw new Error(`Feishu token request failed: ${String(result.code)} ${result.msg ?? ""}`);
    }

    // Refresh five minutes early; `expire` is in seconds (at most two hours).
    tenantTokenCache.set(cacheKey, { expiresAt: Date.now() + Math.max(0, (result.expire ?? 0) - 300) * 1000, token: result.tenant_access_token });

    return result.tenant_access_token;
};

export interface FeishuCredentials {
    appId: string;
    appSecret: string;
    domain?: string;
}

const postFeishuMessage = async (base: string, token: string, chatId: string, messageType: string, content: Record<string, string>): Promise<void> => {
    const response = await fetchWithDeadline(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        body: JSON.stringify({ content: JSON.stringify(content), msg_type: messageType, receive_id: chatId }),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;

    if (!response.ok || result?.code !== 0) {
        throw new Error(`Feishu send failed: ${String(response.status)} ${String(result?.code)} ${result?.msg ?? ""}`);
    }
};

export const sendFeishuMessage = async (credentials: FeishuCredentials, chatId: string, text: string): Promise<void> => {
    const base = feishuApiBase(credentials.domain);
    const token = await getTenantAccessToken(base, credentials.appId, credentials.appSecret);

    for (const chunk of splitMessage(text, FEISHU_TEXT_MAX)) {
        await postFeishuMessage(base, token, chatId, "text", { text: chunk });
    }
};

/** Download a message's image or file with the app's tenant token; voice notes are files to this endpoint. */
export const downloadFeishuResource = async (credentials: FeishuCredentials, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    if (!attachment.messageId) {
        throw new Error("Feishu resource has no message id");
    }

    const base = feishuApiBase(credentials.domain);
    const token = await getTenantAccessToken(base, credentials.appId, credentials.appSecret);
    const type = attachment.kind === "image" ? "image" : "file";

    return await fetchMedia(
        `${base}/open-apis/im/v1/messages/${encodeURIComponent(attachment.messageId)}/resources/${encodeURIComponent(attachment.ref)}?type=${type}`,
        {
            allowedHosts: [new URL(base).hostname],
            headers: { Authorization: `Bearer ${token}` },
        },
    );
};

/** Upload to Feishu (multipart) and return the key its data field names. */
const uploadFeishu = async (base: string, token: string, path: "files" | "images", form: FormData, keyField: "file_key" | "image_key"): Promise<string> => {
    const response = await fetchOk(`${base}/open-apis/im/v1/${path}`, {
        body: form,
        errorPrefix: `Feishu ${path} upload failed`,
        headers: { Authorization: `Bearer ${token}` },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_LONG_MS,
    });
    const result = (await response.json()) as { code?: number; data?: Record<string, unknown>; msg?: string };
    const key = result.data?.[keyField];

    if (result.code !== 0 || typeof key !== "string") {
        throw new Error(`Feishu ${path} upload failed: ${String(result.code)} ${result.msg ?? ""}`);
    }

    return key;
};

/** Upload a file and post it: images as image messages, everything else as file messages. */
export const sendFeishuMedia = async (credentials: FeishuCredentials, chatId: string, file: OutboundFile): Promise<MediaSendResult> => {
    const base = feishuApiBase(credentials.domain);
    const token = await getTenantAccessToken(base, credentials.appId, credentials.appSecret);
    const form = new FormData();

    if (file.mediaType.startsWith("image/")) {
        form.set("image_type", "message");
        form.set("image", toBlob(file), file.name);

        await postFeishuMessage(base, token, chatId, "image", { image_key: await uploadFeishu(base, token, "images", form, "image_key") });

        return "sent";
    }

    form.set("file_type", FEISHU_FILE_TYPES[file.mediaType] ?? "stream");
    form.set("file_name", file.name);
    form.set("file", toBlob(file), file.name);

    await postFeishuMessage(base, token, chatId, "file", { file_key: await uploadFeishu(base, token, "files", form, "file_key") });

    return "sent";
};
