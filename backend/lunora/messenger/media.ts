/**
 * Media in the scheduled reply action (`messenger/respond.ts`) — never in the
 * webhook, which has seconds to answer.
 *
 * Inbound: each attachment is downloaded with the owner's bot token
 * (`lib/platform-media.ts`, host-pinned and size-capped in `lib/media.ts`),
 * typed by the allowlist, and stored content-addressed through `storeFile` —
 * which writes the `chatFiles` row and the owner's `chatFileAccess` grant. The
 * user message then carries every stored file in `fileIds`, and as parts only
 * what a model reads directly (images, PDFs). Voice notes and audio are
 * transcribed through the same action workflows use
 * (`chat_functions.generateTranscription`) and reach the model as text, the
 * recording staying attached. Text documents are inlined; other documents are
 * named. Anything that could not be taken is named with the reason, so the
 * model — and the owner reading the thread — knows it was sent.
 *
 * Outbound: files the reply produced are read back from storage and sent
 * through each platform's media API, or as a signed link where the platform
 * cannot take the file.
 */
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { storeFile } from "../agent/client/files";
import { readStoredObject, signedReadUrl } from "../lib/storage-read";
import { toStorageRef } from "../lib/storage-ref";
import type { InboundAttachment, MediaBytes, OutboundFile } from "./lib/media";
import {
    defaultAttachmentName,
    fileLinkText,
    MediaDownloadError,
    MESSENGER_LINK_TTL_SECONDS,
    MESSENGER_MAX_ATTACHMENTS,
    MESSENGER_MEDIA_MAX_BYTES,
    MESSENGER_MAX_TRANSCRIPTIONS,
    MESSENGER_MEDIA_TYPES,
    MESSENGER_TRANSCRIBE_MAX_BYTES,
    MODEL_READABLE_TYPES,
    resolveMediaType,
    TEXT_DOCUMENT_TYPES,
} from "./lib/media";
import type { Delivery } from "./lib/platform-media";
import { downloadAttachment, sendPlatformMedia } from "./lib/platform-media";

/** Characters of a text document inlined into the prompt. */
const INLINE_TEXT_MAX_CHARS = 20_000;

/** Longest file name kept; longer ones are cut, extension preserved. */
const MAX_NAME_LENGTH = 120;

// eslint-disable-next-line no-control-regex -- stripping them is the point
const CONTROL_CHARACTERS_RE = /[\u{0}-\u{1F}\u{7F}]/gu;
const PATH_SEPARATOR_RE = /[/\\]/u;

const ALLOWED_TYPES = [...MESSENGER_MEDIA_TYPES];

export type StoredMediaPart = { data: string; filename?: string; mediaType: string; type: "file" } | { image: string; mediaType: string; type: "image" };

export interface IngestedMessage {
    fileIds: Id<"chatFiles">[];
    /** Whether anything reached the model: a caption, a stored file or a transcript. */
    hasContent: boolean;
    parts: StoredMediaPart[];
    /** The caption plus a line per attachment — what the model reads as the message's text. */
    text: string;
}

/** A display name from an untrusted one: no control characters or path, capped. */
export const sanitizeAttachmentName = (name: string | undefined): string | undefined => {
    const clean = (name ?? "").replaceAll(CONTROL_CHARACTERS_RE, "").split(PATH_SEPARATOR_RE).pop()?.trim() ?? "";

    if (!clean) {
        return undefined;
    }

    if (clean.length <= MAX_NAME_LENGTH) {
        return clean;
    }

    const dot = clean.lastIndexOf(".");
    const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";

    return clean.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
};

const SKIP_REASONS: Readonly<Record<string, string>> = {
    failed: "it could not be downloaded",
    "too-large": `it is larger than ${String(MESSENGER_MEDIA_MAX_BYTES / 1024 / 1024)} MB`,
    "too-many": `only ${String(MESSENGER_MAX_ATTACHMENTS)} attachments are read per message`,
    "unsupported-type": "this type of file is not supported",
};

const skippedLine = (attachment: InboundAttachment, reason: keyof typeof SKIP_REASONS): string => {
    const name = sanitizeAttachmentName(attachment.name);
    const label = name ? `Attachment "${name}"` : "Attachment";
    const subject = attachment.kind === "voice" ? "Voice message" : label;

    return `[${subject} not read: ${SKIP_REASONS[reason]!}]`;
};

const isAudio = (attachment: InboundAttachment, mediaType: string): boolean =>
    attachment.kind === "voice" || attachment.kind === "audio" || mediaType.startsWith("audio/");

/**
 * The transcript of a stored recording, or `null` when transcription is
 * unavailable, failed, or the owner's daily audio quota is spent. Charged
 * BEFORE the call: the platform's FAL key pays for it, and the sender is a
 * third party the owner does not control.
 */
const transcribe = async (context: ActionCtx, audioUrl: string, threadId: string, userId: string): Promise<string | null> => {
    try {
        if (!(await context.runMutation(internal.chat.daily_charge.chargeDailyUnit, { kind: "Audio", userId }))) {
            return null;
        }

        const result = await context.runAction(internal.chat.functions.generateTranscription, { audioUrl, threadId, userId });

        return result.text.trim() || null;
    } catch (error) {
        console.warn("[Messenger] Transcription failed:", error instanceof Error ? error.message : error);

        return null;
    }
};

const voiceLine = (transcript: string | null, reason = "it could not be transcribed"): string =>
    transcript ? `[Voice message transcript]\n${transcript}` : `[Voice message: ${reason}]`;

/**
 * Only the start of a text document is inlined, so only the start is decoded:
 * decoding a 20 MB file whole to keep 20,000 characters was one more full copy.
 * A UTF-8 character is at most four bytes.
 */
const decodeInlineText = (bytes: MediaBytes): string => new TextDecoder().decode(bytes.subarray(0, INLINE_TEXT_MAX_CHARS * 4 + 4));

/**
 * Download, store and describe a message's attachments. Never throws for one
 * bad attachment — each failure becomes a line in the text instead.
 */
export const ingestAttachments = async (
    context: ActionCtx,
    options: { attachments: InboundAttachment[]; caption?: string; keys: Record<string, string>; platform: string; threadId: string; userId: string },
): Promise<IngestedMessage> => {
    const { attachments, caption, keys, platform, threadId, userId } = options;
    const lines: string[] = caption?.trim() ? [caption.trim()] : [];
    const fileIds: Id<"chatFiles">[] = [];
    const parts: StoredMediaPart[] = [];
    let hasContent = lines.length > 0;
    let transcriptions = 0;

    for (const [index, attachment] of attachments.entries()) {
        if (index >= MESSENGER_MAX_ATTACHMENTS) {
            lines.push(skippedLine(attachment, "too-many"));
            continue;
        }

        if ((attachment.size ?? 0) > MESSENGER_MEDIA_MAX_BYTES) {
            lines.push(attachment.transcript ? voiceLine(attachment.transcript) : skippedLine(attachment, "too-large"));
            hasContent ||= Boolean(attachment.transcript);
            continue;
        }

        let stored: Awaited<ReturnType<typeof storeFile>>;
        let mediaType: string;
        let bytes: MediaBytes;
        let name: string;

        try {
            const download = await downloadAttachment(platform, keys, attachment);
            const resolved = resolveMediaType({ declared: attachment.mimeType, name: attachment.name, response: download.contentType });

            if (!resolved) {
                throw new MediaDownloadError("unsupported-type", "Attachment type not allowed");
            }

            mediaType = resolved;
            bytes = download.bytes;
            name = sanitizeAttachmentName(attachment.name) ?? defaultAttachmentName(attachment.kind, mediaType);
            stored = await storeFile(context, new Blob([bytes], { type: mediaType }), {
                allowedContentTypes: ALLOWED_TYPES,
                filename: name,
                maxSize: MESSENGER_MEDIA_MAX_BYTES,
                threadId,
                userId,
            });
        } catch (error) {
            console.warn(`[Messenger] ${platform} attachment not ingested:`, error instanceof Error ? error.message : error);

            // WeChat's own recognition still gives the model the words.
            if (attachment.transcript) {
                lines.push(voiceLine(attachment.transcript));
                hasContent = true;
            } else {
                lines.push(skippedLine(attachment, error instanceof MediaDownloadError ? error.reason : "failed"));
            }

            continue;
        }

        const { fileId, storageId } = stored.file;
        const reference = toStorageRef(storageId);

        fileIds.push(fileId as Id<"chatFiles">);
        hasContent = true;

        if (isAudio(attachment, mediaType)) {
            if (attachment.transcript) {
                lines.push(voiceLine(attachment.transcript));
            } else if (transcriptions >= MESSENGER_MAX_TRANSCRIPTIONS) {
                lines.push(voiceLine(null, `only ${String(MESSENGER_MAX_TRANSCRIPTIONS)} recordings are transcribed per message`));
            } else if (bytes.byteLength > MESSENGER_TRANSCRIBE_MAX_BYTES) {
                lines.push(voiceLine(null, `it is larger than ${String(MESSENGER_TRANSCRIBE_MAX_BYTES / 1024 / 1024)} MB, too long to transcribe`));
            } else {
                transcriptions += 1;
                lines.push(voiceLine(await transcribe(context, stored.file.url, threadId, userId)));
            }
        } else if (mediaType.startsWith("image/")) {
            parts.push({ image: reference, mediaType, type: "image" });
        } else if (MODEL_READABLE_TYPES.has(mediaType)) {
            parts.push({ data: reference, filename: name, mediaType, type: "file" });
        } else if (TEXT_DOCUMENT_TYPES.has(mediaType)) {
            const text = decodeInlineText(bytes);
            const clipped = text.length > INLINE_TEXT_MAX_CHARS ? `${text.slice(0, INLINE_TEXT_MAX_CHARS)}\n[… truncated]` : text;

            lines.push(`[Document: ${name}]\n${clipped}`);
        } else {
            lines.push(`[Attached file: ${name} (${mediaType}) — its contents cannot be read here]`);
        }
    }

    return { fileIds, hasContent, parts, text: lines.join("\n\n") };
};

/**
 * Send the files a reply produced. Each goes through the platform's media API;
 * one the platform cannot take, or whose upload fails, goes as a signed link.
 * Returns `"window_closed"` as soon as the platform says the reply window has
 * closed — nothing after that could be delivered either.
 */
export const sendReplyMedia = async (
    context: ActionCtx,
    options: {
        delivery: Delivery;
        keys: Record<string, string>;
        sendText: (text: string) => Promise<"sent" | "window_closed">;
        threadId: string;
        userId: string;
    },
): Promise<"sent" | "window_closed"> => {
    const { delivery, keys, sendText, threadId, userId } = options;
    const files = await context.runQuery(internal.messenger.functions.listReplyMedia, { threadId: threadId as Id<"threads">, userId });

    for (const file of files) {
        let outbound: OutboundFile;

        try {
            const object = await readStoredObject(context.storage, file.key, { maxBytes: MESSENGER_MEDIA_MAX_BYTES });

            outbound = {
                bytes: new Uint8Array(object.bytes),
                mediaType: file.mediaType,
                name: sanitizeAttachmentName(file.filename) ?? defaultAttachmentName("file", file.mediaType),
                url: await signedReadUrl(context.storage, file.key, MESSENGER_LINK_TTL_SECONDS),
            };
        } catch (error) {
            console.warn("[Messenger] Reply file not sent:", error instanceof Error ? error.message : error);
            continue;
        }

        let result: "sent" | "unsupported" | "window_closed";

        try {
            result = await sendPlatformMedia(delivery, outbound, keys);
        } catch (error) {
            console.warn(`[Messenger] ${delivery.platform} media upload failed, sending a link:`, error instanceof Error ? error.message : error);
            result = "unsupported";
        }

        if (result === "unsupported") {
            result = await sendText(fileLinkText(outbound));
        }

        if (result === "window_closed") {
            return "window_closed";
        }
    }

    return "sent";
};
