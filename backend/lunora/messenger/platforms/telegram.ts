/**
 * Telegram Bot API utilities for messenger integration.
 *
 * Handles webhook validation, message parsing, and sending messages
 * back to Telegram chats.
 * @see https://core.telegram.org/bots/api
 */

import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_SHORT_MS, fetchOk, fetchWithDeadline } from "../../lib/fetch-timeout";
import { timingSafeEqual } from "../../lib/crypto";
import type { DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia, MediaDownloadError, MESSENGER_MEDIA_MAX_BYTES, toBlob } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_HOSTS = ["api.telegram.org"];
/** `sendPhoto` takes at most 10 MB; a larger image goes as a document. */
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * How old an update may be and still be answered. Telegram keeps an
 * undelivered update for 24 hours and retries it; anything older is a replay.
 */
export const TELEGRAM_UPDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface TelegramFile {
    file_id: string;
    file_name?: string;
    file_size?: number;
    mime_type?: string;
}

/** Telegram Update object (simplified) */
interface TelegramUpdate {
    message?: {
        audio?: TelegramFile;
        caption?: string;
        chat: {
            id: number;
            type: string;
        };
        date: number;
        document?: TelegramFile;
        from: {
            first_name: string;
            id: number;
            is_bot: boolean;
            username?: string;
        };
        message_id: number;
        /** Every size Telegram made of the photo, smallest first. */
        photo?: TelegramFile[];
        text?: string;
        voice?: TelegramFile;
    };
    update_id: number;
}

/** Message fields we do not read, answered with the "unsupported" notice rather than silence. */
const UNREAD_CONTENT = ["animation", "contact", "location", "poll", "sticker", "venue", "video", "video_note"] as const;

/** The attachments of a message: the largest photo that fits, a document, a voice note or an audio file. */
const telegramAttachments = (message: NonNullable<TelegramUpdate["message"]>): InboundAttachment[] => {
    const attachments: InboundAttachment[] = [];
    const photo = message.photo?.toReversed().find((size) => (size.file_size ?? 0) <= MESSENGER_MEDIA_MAX_BYTES) ?? message.photo?.at(-1);

    if (photo) {
        attachments.push({ kind: "image", mimeType: "image/jpeg", ref: photo.file_id, size: photo.file_size });
    }

    if (message.document) {
        attachments.push({
            kind: message.document.mime_type?.startsWith("image/") ? "image" : "file",
            mimeType: message.document.mime_type,
            name: message.document.file_name,
            ref: message.document.file_id,
            size: message.document.file_size,
        });
    }

    if (message.voice) {
        attachments.push({ kind: "voice", mimeType: message.voice.mime_type ?? "audio/ogg", ref: message.voice.file_id, size: message.voice.file_size });
    }

    if (message.audio) {
        attachments.push({
            kind: "audio",
            mimeType: message.audio.mime_type,
            name: message.audio.file_name,
            ref: message.audio.file_id,
            size: message.audio.file_size,
        });
    }

    return attachments;
};

/**
 * Validate a Telegram webhook request using the secret token.
 * Telegram sends the secret as `X-Telegram-Bot-Api-Secret-Token` header.
 */
export const shouldValidateTelegramWebhook = (request: Request, webhookSecret: string): boolean => {
    const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");

    if (!secretHeader) {
        return false;
    }

    return timingSafeEqual(secretHeader, webhookSecret);
};

/**
 * Parse a Telegram Update payload into the shared inbound shape: text, or
 * photos, documents, voice notes and audio (with their caption). Stickers,
 * locations and the like are `"unsupported"`; bots and service messages (a
 * member joined, a title changed) are null.
 */
export const parseTelegramUpdate = (body: unknown): InboundMessage | null => {
    const message = (body as TelegramUpdate | null)?.message;

    if (!message?.from || message.from.is_bot || !message.chat) {
        return null;
    }

    const attachments = telegramAttachments(message);
    const text = message.text ?? message.caption;

    if (!text && attachments.length === 0 && UNREAD_CONTENT.every((field) => !(field in message))) {
        return null;
    }

    const chatId = String(message.chat.id);

    return {
        ...(attachments.length > 0 && { attachments }),
        chatId,
        eventId: `${chatId}:${String(message.message_id)}`,
        kind: inboundKind(text, attachments),
        senderId: String(message.from.id),
        senderName: message.from.first_name,
        senderUsername: message.from.username,
        text: text || undefined,
        timestampMs: message.date * 1000,
    };
};

/**
 * Download an attachment: `getFile` names its path, then the file endpoint
 * serves it. The bot token is in both URLs, so neither is ever logged.
 */
export const downloadTelegramFile = async (botToken: string, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    const response = await fetchOk(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${encodeURIComponent(attachment.ref)}`, {
        errorPrefix: "Telegram getFile failed",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json()) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    const filePath = result.result?.file_path;

    if (!result.ok || !filePath) {
        throw new MediaDownloadError("failed", "Telegram getFile returned no file path");
    }

    if ((result.result?.file_size ?? 0) > MESSENGER_MEDIA_MAX_BYTES) {
        throw new MediaDownloadError("too-large", "Telegram file is over the size limit");
    }

    return await fetchMedia(
        `${TELEGRAM_API}/file/bot${botToken}/${filePath
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}`,
        { allowedHosts: TELEGRAM_HOSTS },
    );
};

/** The Bot API method and field for a file: photos inline, voice notes as voice, audio as audio, the rest as documents. */
const telegramSendMethod = (file: OutboundFile): { field: string; method: string } => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mediaType) && file.bytes.byteLength <= TELEGRAM_PHOTO_MAX_BYTES) {
        return { field: "photo", method: "sendPhoto" };
    }

    if (file.mediaType === "audio/ogg") {
        return { field: "voice", method: "sendVoice" };
    }

    if (file.mediaType === "audio/mpeg" || file.mediaType === "audio/mp4") {
        return { field: "audio", method: "sendAudio" };
    }

    return { field: "document", method: "sendDocument" };
};

/** Upload a file into the chat (multipart). Throws on failure; the caller falls back to a link. */
export const sendTelegramMedia = async (botToken: string, chatId: string, file: OutboundFile): Promise<MediaSendResult> => {
    const { field, method } = telegramSendMethod(file);
    const form = new FormData();

    form.set("chat_id", chatId);
    form.set(field, toBlob(file), file.name);

    const response = await fetchOk(`${TELEGRAM_API}/bot${botToken}/${method}`, {
        body: form,
        errorPrefix: `Telegram ${method} failed`,
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_LONG_MS,
    });

    await response.body?.cancel();

    return "sent";
};

/**
 * Send a text message to a Telegram chat via the Bot API.
 */
export const sendTelegramMessage = async (botToken: string, chatId: number | string, text: string): Promise<boolean> => {
    // Telegram messages max 4096 chars; split if needed
    const chunks = splitMessage(text, 4096);

    for (const chunk of chunks) {
        const response = await fetchWithDeadline(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            body: JSON.stringify({
                chat_id: chatId,
                parse_mode: "Markdown",
                text: chunk,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            timeoutMs: FETCH_TIMEOUT_SHORT_MS,
        });

        if (!response.ok) {
            const errorBody = await response.text();

            console.error(`Telegram sendMessage failed: ${response.status} ${errorBody}`);

            return false;
        }
    }

    return true;
};
