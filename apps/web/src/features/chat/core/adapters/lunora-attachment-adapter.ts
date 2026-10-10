import { api } from "@neore/backend/api";
import { CHAT_UPLOAD_CONTENT_MISMATCH, CHAT_UPLOAD_EXPIRED, CHAT_UPLOAD_TOO_LARGE, CHAT_UPLOAD_UNSUPPORTED_TYPE } from "@neore/backend/chat-upload-codes";
import { chatAttachmentLimit } from "@neore/backend/document-limits";

import type { LunoraReactClient as LunoraClient } from "@/lib/lunora/crpc";
import { UploadFailedError } from "@/lib/upload/upload-error";
import { uploadFile } from "@/lib/upload/upload-file";

import { AttachmentUploadError } from "./attachment-upload-error";

export type { AttachmentUploadFailure } from "./attachment-upload-error";
export { AttachmentUploadError } from "./attachment-upload-error";

export interface PendingAttachment {
    contentType?: string;
    file: File;
    id: string;
    name: string;
    status: { reason: string; type: "requires-action" } | { type: "running" };
    type: "image" | "document";
}

export interface CompleteAttachment extends Omit<PendingAttachment, "status"> {
    content: ({ image: string; type: "image" } | { text: string; type: "text" })[];
    metadata?: { fileId?: string };
    status: { type: "complete" };
}

export type Attachment = PendingAttachment | CompleteAttachment;

/**
 * Reads the Lunora file id an attachment picked up during upload.
 */
export const getAttachmentFileId = (attachment: Attachment): string | undefined => {
    if (!("metadata" in attachment)) {
        return undefined;
    }

    const fileId = attachment.metadata?.fileId;

    return typeof fileId === "string" ? fileId : undefined;
};

type ProgressState = { file: File; onProgress?: (progress: number) => void };

export interface AttachmentAdapter {
    accept: string;
    add: (state: ProgressState) => Promise<PendingAttachment>;
    remove: (attachment: Attachment) => Promise<void>;
    send: (attachment: PendingAttachment, onProgress?: (progress: number) => void) => Promise<CompleteAttachment>;

    /**
     * `add` then `send`: validates, uploads, and resolves with the file id in
     * `metadata` — what the composer needs. `add` alone uploads nothing, and the
     * composer used to call only `add`, so no attachment ever reached the backend
     * (its `fileId` was always `undefined` and `/chat/start` got no `fileIds`).
     * Rejects on a refused file or a failed upload.
     */
    upload: (state: ProgressState) => Promise<CompleteAttachment>;
}

const MEGABYTE = 1024 * 1024;

export interface AttachmentSizeLimit {
    /** A document is sent to text extraction; anything else is media. */
    isDocument: boolean;
    maxBytes: number;
}

/**
 * The type an attachment is uploaded — and checked — as. Browsers leave
 * `file.type` empty for some extensions (`.md` on most systems), so those are
 * named here; anything still unknown is `application/octet-stream`, which the
 * backend refuses with a readable error.
 */
export const attachmentContentType = (file: Pick<File, "name" | "type">): string => {
    if (file.type) {
        return file.type;
    }

    const name = file.name.toLowerCase();

    if (name.endsWith(".md") || name.endsWith(".markdown")) {
        return "text/markdown";
    }

    if (name.endsWith(".txt")) {
        return "text/plain";
    }

    if (name.endsWith(".csv")) {
        return "text/csv";
    }

    if (name.endsWith(".docx")) {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }

    return "application/octet-stream";
};

/**
 * The most a chat attachment may weigh — the backend's own rule
 * (`chatAttachmentLimit` in `@neore/backend/document-limits`), which the
 * upload route and the finalize step both enforce. A
 * DOCUMENT gets the document-parser's 25 MB; video 100 MB; images and audio 20 MB.
 */
export const attachmentSizeLimit = (file: Pick<File, "name" | "type">): AttachmentSizeLimit => chatAttachmentLimit(attachmentContentType(file));

/** Thrown for a file over {@link attachmentSizeLimit}; the composer words it (Lingui). */
export class AttachmentTooLargeError extends Error {
    public readonly fileName: string;

    public readonly isDocument: boolean;

    public readonly maxMegabytes: number;

    public constructor(fileName: string, limit: AttachmentSizeLimit) {
        super(`${fileName} exceeds the ${String(limit.maxBytes / MEGABYTE)} MB limit`);
        this.name = "AttachmentTooLargeError";
        this.fileName = fileName;
        this.isDocument = limit.isDocument;
        this.maxMegabytes = Math.floor(limit.maxBytes / MEGABYTE);
    }
}

const serverErrorData = (error: unknown): { code?: unknown; maxBytes?: unknown } | undefined =>
    (error as { data?: { code?: unknown; maxBytes?: unknown } } | null)?.data;

/**
 * Turns a failure of the upload flow into one of the typed errors above, so the
 * composer can word it. An error it does not recognise is returned unchanged.
 */
export const toAttachmentError = (error: unknown, file: Pick<File, "name" | "type">): unknown => {
    if (error instanceof UploadFailedError) {
        switch (error.reason) {
            case "expired": {
                return new AttachmentUploadError(file.name, "expired", error);
            }
            case "too-large": {
                return new AttachmentTooLargeError(file.name, attachmentSizeLimit(file));
            }
            case "unsupported": {
                return new AttachmentUploadError(file.name, "unsupported", error);
            }
            default: {
                return new AttachmentUploadError(file.name, "failed", error);
            }
        }
    }

    const data = serverErrorData(error);

    switch (data?.code) {
        case CHAT_UPLOAD_CONTENT_MISMATCH: {
            return new AttachmentUploadError(file.name, "content-mismatch", error);
        }
        case CHAT_UPLOAD_EXPIRED: {
            return new AttachmentUploadError(file.name, "expired", error);
        }
        case CHAT_UPLOAD_TOO_LARGE: {
            const limit = attachmentSizeLimit(file);

            return new AttachmentTooLargeError(file.name, typeof data.maxBytes === "number" ? { ...limit, maxBytes: data.maxBytes } : limit);
        }
        case CHAT_UPLOAD_UNSUPPORTED_TYPE: {
            return new AttachmentUploadError(file.name, "unsupported", error);
        }
        default: {
            return error;
        }
    }
};

/** Share of the progress bar the byte transfer fills; finalize (hash, dedupe, grant) is the rest. */
const TRANSFER_SHARE = 95;

/**
 * Uploads one chat attachment: the bytes go to the backend's TUS upload route
 * with progress (`uploadFile`), then `file.finalizeChatUpload` turns the upload
 * into the `chatFiles` id `/chat/start` takes. Failures are thrown as
 * {@link AttachmentTooLargeError} / {@link AttachmentUploadError} where they are
 * recognised.
 *
 * The bytes never ride in an RPC body: Lunora caps that at 1 MiB, which is
 * what made every attachment over ~750 KB fail before.
 */
export const uploadChatAttachment = async (
    lunora: LunoraClient,
    file: File,
    options: { onProgress?: (progress: number) => void; signal?: AbortSignal } = {},
): Promise<{ fileId: string; url: string }> => {
    const contentType = attachmentContentType(file);

    try {
        const uploadId = await uploadFile(file, {
            contentType,
            onProgress: options.onProgress && ((percent) => options.onProgress?.(Math.round((percent * TRANSFER_SHARE) / 100))),
            signal: options.signal,
        });

        return await lunora.action(api.file.finalizeChatUpload, { filename: file.name, uploadId });
    } catch (error) {
        throw toAttachmentError(error, file);
    }
};

const fileToBase64DataURL = async (file: File): Promise<string> =>
    await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.addEventListener("load", () => {
            resolve(reader.result as string);
        });
        reader.addEventListener("error", reject);
        reader.readAsDataURL(file);
    });

const getFileLabel = (isVideo: boolean | undefined, isAudio: boolean | undefined): string => {
    if (isVideo) {
        return "Video";
    }

    if (isAudio) {
        return "Audio";
    }

    return "Document";
};

const isTextAttachment = (contentType: string | undefined, name: string): boolean =>
    Boolean(contentType?.startsWith("text/")) ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".csv");

/**
 * A closure rather than a class: two of the three adapter members never touched
 * the instance, so `this` was buying nothing.
 */
export const createLunoraAttachmentAdapter = (lunora: LunoraClient): AttachmentAdapter => {
    // Accept common file types - images, text, documents, PDFs, video, audio, DOCX
    const accept =
        "image/*,text/*,video/*,audio/*,application/pdf,application/json,application/xml,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.md,.csv,.txt,.docx,.mp4,.mp3,.wav,.webm,.ogg,.m4a,.mov";

    const add = async (state: ProgressState): Promise<PendingAttachment> => {
        const contentType = attachmentContentType(state.file);
        const isImage = contentType.startsWith("image/");
        const isVideo = contentType.startsWith("video/");
        const isAudio = contentType.startsWith("audio/");
        const isText = isTextAttachment(contentType, state.file.name);
        const isPdf = contentType === "application/pdf";
        const isDocx = contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        if (!isImage && !isText && !isPdf && !isVideo && !isAudio && !isDocx) {
            throw new AttachmentUploadError(state.file.name, "unsupported");
        }

        const limit = attachmentSizeLimit(state.file);

        if (state.file.size > limit.maxBytes) {
            throw new AttachmentTooLargeError(state.file.name, limit);
        }

        return {
            contentType,
            file: state.file,
            id: crypto.randomUUID(),
            name: state.file.name,
            status: { reason: "composer-send", type: "requires-action" },
            type: isImage ? "image" : "document",
        };
    };

    /** Uploads; a failure REJECTS (the composer marks the attachment failed) rather than resolving with an error text. */
    const send = async (attachment: PendingAttachment, onProgress?: (progress: number) => void): Promise<CompleteAttachment> => {
        const { fileId } = await uploadChatAttachment(lunora, attachment.file, { onProgress });
        const isImage = attachment.contentType?.startsWith("image/");

        // Images: a data URL for immediate display; the backend has the bytes.
        if (isImage) {
            return {
                ...attachment,
                content: [{ image: await fileToBase64DataURL(attachment.file), type: "image" }],
                metadata: { fileId },
                status: { type: "complete" },
            };
        }

        // Text files: the content inline as well.
        if (isTextAttachment(attachment.contentType, attachment.name)) {
            const textContent = await attachment.file.text();

            return {
                ...attachment,
                content: [{ text: `<attachment name="${attachment.name}">\n${textContent}\n</attachment>`, type: "text" }],
                metadata: { fileId },
                status: { type: "complete" },
            };
        }

        // Anything else (PDF, DOCX, video, audio): the filename.
        const fileLabel = getFileLabel(attachment.contentType?.startsWith("video/"), attachment.contentType?.startsWith("audio/"));

        return {
            ...attachment,
            content: [{ text: `[${fileLabel}: ${attachment.name}]`, type: "text" }],
            metadata: { fileId },
            status: { type: "complete" },
        };
    };

    const upload = async (state: ProgressState): Promise<CompleteAttachment> => await send(await add(state), state.onProgress);

    const remove = async (_attachment: Attachment): Promise<void> => {};

    return { accept, add, remove, send, upload };
};
