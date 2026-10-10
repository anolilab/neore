/**
 * WeChat Official Account adapter — BETA.
 *
 * Beta because it has not been exercised against a live account: a real
 * Official Account needs a Chinese entity, and the customer-service send API
 * needs a verified Service Account (the public sandbox test account offers it).
 *
 * - Server verification is a GET: `signature = SHA-1(sort([token, timestamp,
 *   nonce]).join(""))`, answered with `echostr`.
 * - We accept messages in **safe mode only** (`encrypt_type=aes`). In plaintext
 *   mode `signature` covers the token, timestamp and nonce but NOT the body, so
 *   a captured request could carry any body within its window. Safe mode's
 *   `msg_signature = SHA-1(sort([token, timestamp, nonce, Encrypt]).join(""))`
 *   covers the ciphertext, and decryption proves the EncodingAESKey.
 * - Ciphertext: AES-256-CBC, key = base64(EncodingAESKey + "="), IV = first 16
 *   key bytes, PKCS#7 padded to 32-byte blocks; the plaintext is 16 random bytes,
 *   a 4-byte big-endian length, the XML, then the AppID (which we check).
 * - WeChat wants an answer within 5s, so the webhook answers `success` at once
 *   and the reply goes out through the customer-service message API, which is
 *   only open for 48 hours after the user's last message (errcode 45015).
 * @see https://developers.weixin.qq.com/doc/service/en/guide/dev/push/
 * @see https://developers.weixin.qq.com/doc/offiaccount/en/Message_Management/Receiving_standard_messages.html
 * @see https://developers.weixin.qq.com/doc/offiaccount/en/Message_Management/Service_Center_messages.html
 * @see https://developers.weixin.qq.com/doc/offiaccount/en/Basic_Information/getStableAccessToken.html
 */
import { compareStrings } from "../../lib/collections";
import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_SHORT_MS, fetchOk } from "../../lib/fetch-timeout";
import { base64ToBytes, digestHex, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, timingSafeEqual } from "../../lib/crypto";
import type { DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia, MediaDownloadError, toBlob } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

const WECHAT_API = "https://api.weixin.qq.com/cgi-bin";
/** Temporary media: images up to 10 MB (JPG/PNG), voice up to 2 MB (AMR/MP3). */
const WECHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const WECHAT_VOICE_MAX_BYTES = 2 * 1024 * 1024;
const WECHAT_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);
const WECHAT_VOICE_TYPES: ReadonlySet<string> = new Set(["audio/amr", "audio/mpeg"]);

/** Customer-service messages are allowed for 48 hours after the user last wrote. */
export const WECHAT_SERVICE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** errcode for a customer-service message outside the 48-hour window. */
export const WECHAT_WINDOW_CLOSED_ERROR = 45_015;

/** Customer-service text is capped at 2048 bytes; 600 characters stays under it even for CJK (3 bytes each). */
const WECHAT_TEXT_MAX = 600;

const sha1OfSorted = async (parts: string[]): Promise<string> => await digestHex("SHA-1", parts.toSorted(compareStrings).join(""));

/** The GET handshake's `signature`, or `msg_signature` when `encrypted` is passed. */
export const validateWeChatSignature = async (
    parameters: { encrypted?: string; nonce: string | null; signature: string | null; timestamp: string | null },
    token: string,
    nowMs: number = Date.now(),
): Promise<boolean> => {
    const { encrypted, nonce, signature, timestamp } = parameters;

    if (!signature || !timestamp || !nonce || !isWithinWindow(Number(timestamp) * 1000, SIGNED_REQUEST_WINDOW_MS, nowMs)) {
        return false;
    }

    const parts = encrypted === undefined ? [token, timestamp, nonce] : [token, timestamp, nonce, encrypted];

    return timingSafeEqual(signature.toLowerCase(), await sha1OfSorted(parts));
};

/** Read one element's text out of WeChat's flat XML (CDATA or plain). */
export const readXmlField = (xml: string, tag: string): string | undefined => {
    const match = new RegExp(String.raw`<${tag}>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*</${tag}>`).exec(xml);

    return match ? (match[1] ?? match[2]) : undefined;
};

const importAesKey = async (encodingAesKey: string): Promise<{ iv: Uint8Array; key: CryptoKey }> => {
    const raw = base64ToBytes(`${encodingAesKey}=`);

    if (raw.length !== 32) {
        throw new Error("EncodingAESKey must decode to 32 bytes");
    }

    const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);

    return { iv: raw.slice(0, 16), key };
};

/**
 * Decrypt a safe-mode `Encrypt` value and check it was made for `appId`.
 *
 * WebCrypto only understands 16-byte PKCS#7 padding and rejects WeChat's
 * 32-byte variant whenever the pad exceeds 16. So we append one extra
 * ciphertext block that decrypts to a full 16-byte pad (CBC lets us compute it:
 * encrypt sixteen 0x10 bytes chained off the last real block), let WebCrypto
 * strip that, and remove WeChat's padding by hand.
 */
export const decryptWeChatMessage = async (encrypted: string, encodingAesKey: string, appId: string): Promise<string> => {
    const { iv, key } = await importAesKey(encodingAesKey);
    const ciphertext = base64ToBytes(encrypted);

    if (ciphertext.length === 0 || ciphertext.length % 32 !== 0) {
        throw new Error("WeChat ciphertext is not block-aligned");
    }

    const lastBlock = ciphertext.slice(-16);
    const padBlock = new Uint8Array(await crypto.subtle.encrypt({ iv: lastBlock, name: "AES-CBC" }, key, new Uint8Array(16).fill(16))).slice(0, 16);
    const extended = new Uint8Array(ciphertext.length + 16);

    extended.set(ciphertext);
    extended.set(padBlock, ciphertext.length);

    const padded = new Uint8Array(await crypto.subtle.decrypt({ iv, name: "AES-CBC" }, key, extended));
    const pad = padded.at(-1) ?? 0;

    if (pad < 1 || pad > 32) {
        throw new Error("Invalid WeChat padding");
    }

    const plaintext = padded.slice(0, padded.length - pad);

    if (plaintext.length < 20) {
        throw new Error("WeChat plaintext too short");
    }

    const length = new DataView(plaintext.buffer, plaintext.byteOffset + 16, 4).getUint32(0);
    const decoder = new TextDecoder();
    const xml = decoder.decode(plaintext.slice(20, 20 + length));
    const receivedAppId = decoder.decode(plaintext.slice(20 + length));

    if (!timingSafeEqual(receivedAppId, appId)) {
        throw new Error("WeChat message was encrypted for a different AppID");
    }

    return xml;
};

/**
 * An `image` or `voice` message's media. A voice note carries WeChat's own
 * speech recognition in `Recognition` when the account has it switched on.
 */
const weChatAttachments = (xml: string, type: string): InboundAttachment[] => {
    const mediaId = readXmlField(xml, "MediaId");

    if (!mediaId) {
        return [];
    }

    if (type === "image") {
        return [{ kind: "image", mimeType: "image/jpeg", ref: mediaId }];
    }

    if (type === "voice") {
        const recognition = readXmlField(xml, "Recognition")?.trim();

        return [
            {
                kind: "voice",
                ...(readXmlField(xml, "Format")?.toLowerCase() === "amr" && { mimeType: "audio/amr" }),
                ref: mediaId,
                ...(recognition && { transcript: recognition }),
            },
        ];
    }

    return [];
};

/**
 * A user message, or null for events (subscribe, menu clicks…). Images and
 * voice notes are media; video, locations and links become `"unsupported"`.
 */
export const parseWeChatMessage = (xml: string): InboundMessage | null => {
    const type = readXmlField(xml, "MsgType");
    const from = readXmlField(xml, "FromUserName");
    const messageId = readXmlField(xml, "MsgId");

    if (!type || type === "event" || !from || !messageId) {
        return null;
    }

    const text = type === "text" ? readXmlField(xml, "Content")?.trim() : undefined;
    const attachments = weChatAttachments(xml, type);

    return {
        ...(attachments.length > 0 && { attachments }),
        chatId: from,
        eventId: messageId,
        kind: inboundKind(text, attachments),
        senderId: from,
        text: text || undefined,
        timestampMs: Number(readXmlField(xml, "CreateTime")) * 1000,
    };
};

const accessTokenCache = new Map<string, { expiresAt: number; token: string }>();

/** Forget the cached access token for an app (account deletion). */
export const forgetWeChatTokens = (appId: string): void => {
    accessTokenCache.delete(appId);
};

const getAccessToken = async (appId: string, appSecret: string): Promise<string> => {
    const cached = accessTokenCache.get(appId);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.token;
    }

    // `stable_token` rather than `token`: fetching it does not invalidate the
    // token another server of the same account is using.
    const response = await fetchOk("https://api.weixin.qq.com/cgi-bin/stable_token", {
        body: JSON.stringify({ appid: appId, grant_type: "client_credential", secret: appSecret }),
        errorPrefix: "WeChat token request failed",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json()) as { access_token?: string; errcode?: number; errmsg?: string; expires_in?: number };

    if (!result.access_token) {
        throw new Error(`WeChat token request failed: ${String(result.errcode)} ${result.errmsg ?? ""}`);
    }

    accessTokenCache.set(appId, { expiresAt: Date.now() + Math.max(0, (result.expires_in ?? 0) - 300) * 1000, token: result.access_token });

    return result.access_token;
};

export type WeChatSendResult = "sent" | "window_closed";

/** POST one customer-service message. `"window_closed"` outside the 48-hour window; other errors throw. */
const postWeChatMessage = async (credentials: { appId: string; appSecret: string }, payload: Record<string, unknown>): Promise<WeChatSendResult> => {
    const token = await getAccessToken(credentials.appId, credentials.appSecret);
    const response = await fetchOk(`${WECHAT_API}/message/custom/send?access_token=${encodeURIComponent(token)}`, {
        body: JSON.stringify(payload),
        errorPrefix: "WeChat send failed",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json()) as { errcode?: number; errmsg?: string };

    if (result.errcode === WECHAT_WINDOW_CLOSED_ERROR) {
        return "window_closed";
    }

    if (result.errcode) {
        // 40001 invalid / 42001 expired token: drop it so the next reply fetches a fresh one.
        if (result.errcode === 40_001 || result.errcode === 42_001) {
            forgetWeChatTokens(credentials.appId);
        }

        throw new Error(`WeChat send failed: ${String(result.errcode)} ${result.errmsg ?? ""}`);
    }

    return "sent";
};

export const sendWeChatMessage = async (credentials: { appId: string; appSecret: string }, openId: string, text: string): Promise<WeChatSendResult> => {
    for (const chunk of splitMessage(text, WECHAT_TEXT_MAX)) {
        if ((await postWeChatMessage(credentials, { msgtype: "text", text: { content: chunk }, touser: openId })) === "window_closed") {
            return "window_closed";
        }
    }

    return "sent";
};

/**
 * Download a message's temporary media. The access token rides in the query
 * string (WeChat's design), so the URL is never logged; an error comes back as
 * JSON instead of bytes.
 */
export const downloadWeChatMedia = async (credentials: { appId: string; appSecret: string }, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    const token = await getAccessToken(credentials.appId, credentials.appSecret);
    const media = await fetchMedia(`${WECHAT_API}/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(attachment.ref)}`, {
        allowedHosts: ["api.weixin.qq.com"],
    });

    if (media.contentType?.includes("json") || media.contentType?.startsWith("text/")) {
        throw new MediaDownloadError("failed", "WeChat media/get returned an error");
    }

    return media;
};

/**
 * Upload a file as temporary media and send it: JPEG/PNG as an image, AMR/MP3
 * as a voice message. Anything else (and anything over those types' limits) is
 * `"unsupported"` — customer-service messages carry no files — and goes as a link.
 */
export const sendWeChatMedia = async (credentials: { appId: string; appSecret: string }, openId: string, file: OutboundFile): Promise<MediaSendResult> => {
    const size = file.bytes.byteLength;
    let type: "image" | "voice";

    if (WECHAT_IMAGE_TYPES.has(file.mediaType) && size <= WECHAT_IMAGE_MAX_BYTES) {
        type = "image";
    } else if (WECHAT_VOICE_TYPES.has(file.mediaType) && size <= WECHAT_VOICE_MAX_BYTES) {
        type = "voice";
    } else {
        return "unsupported";
    }

    const token = await getAccessToken(credentials.appId, credentials.appSecret);
    const form = new FormData();

    form.set("media", toBlob(file), file.name);

    const response = await fetchOk(`${WECHAT_API}/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`, {
        body: form,
        errorPrefix: "WeChat media upload failed",
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_LONG_MS,
    });
    const uploaded = (await response.json()) as { errcode?: number; errmsg?: string; media_id?: string };

    if (!uploaded.media_id) {
        throw new Error(`WeChat media upload failed: ${String(uploaded.errcode)} ${uploaded.errmsg ?? ""}`);
    }

    return await postWeChatMessage(credentials, { msgtype: type, touser: openId, [type]: { media_id: uploaded.media_id } });
};
