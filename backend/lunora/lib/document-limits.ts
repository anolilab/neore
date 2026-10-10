/**
 * How large a document may be to have its text extracted.
 *
 * One number, enforced at every hop a document crosses on its way to the
 * document-parser Worker: the web upload UI (chat attachments, which import
 * this module through `@neore/backend/document-limits`), the backend before it
 * stores or reads the bytes (`lib/upload-route.ts`, `lib/chat-upload.ts`, `agent/extraction.ts`,
 * `knowledge/ingest.ts`), and the parser itself (`MAX_DOCUMENT_BYTES` in
 * `services/document-parser/src/shape.rs`, which answers 413). Images, audio and
 * video are not extracted and keep their own limits.
 *
 * No imports: the web app bundles this file.
 */

/**
 * 25 MiB.
 *
 * TODO: To support documents above 25 MB, move extraction to a Cloudflare
 * Container (xberg native server / Docker image) — a Worker isolate has 128 MB
 * and PDF parsing needs ~3× the file size. See docs/plans/document-parser.md.
 */
export const MAX_EXTRACTION_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** {@link MAX_EXTRACTION_DOCUMENT_BYTES} in whole megabytes, for messages. */
export const MAX_EXTRACTION_DOCUMENT_MEGABYTES = MAX_EXTRACTION_DOCUMENT_BYTES / (1024 * 1024);

const MEDIA_MIME_TYPE = /^(?:image|audio|video)\//u;

/**
 * Whether a file of this MIME type is a DOCUMENT for size purposes — sent to
 * extraction — rather than media. Media is anything `image/*`, `audio/*` or
 * `video/*`; everything else a user can attach is a document.
 */
export const isDocumentMimeType = (mimeType: string): boolean => !MEDIA_MIME_TYPE.test(mimeType.trim().toLowerCase());

/** Whether `bytes` exceeds the document cap. */
export const exceedsDocumentLimit = (bytes: number): boolean => bytes > MAX_EXTRACTION_DOCUMENT_BYTES;

const MEGABYTE = 1024 * 1024;

/** The most an image or audio chat attachment may weigh. */
export const MAX_CHAT_MEDIA_BYTES = 20 * MEGABYTE;

/** The most a video chat attachment may weigh. */
export const MAX_CHAT_VIDEO_BYTES = 100 * MEGABYTE;

export interface ChatAttachmentLimit {
    /** A document is sent to text extraction; anything else is media. */
    isDocument: boolean;
    maxBytes: number;
}

/**
 * The most a CHAT attachment of this MIME type may weigh — one rule for the
 * composer's pre-check, the upload route that receives the bytes
 * (`lib/upload-route.ts`, which refuses a larger declared size before storing
 * anything) and the finalize step (which checks the bytes that arrived). A document gets the parser's cap
 * ({@link MAX_EXTRACTION_DOCUMENT_BYTES}); video 100 MB; images and audio 20 MB.
 *
 * Whether the type is accepted at all is a separate question — the backend's
 * MIME allowlist (`vault/lib/file-constants.ts#UPLOAD_ALLOWED_MIME`) answers it.
 */
export const chatAttachmentLimit = (mimeType: string): ChatAttachmentLimit => {
    const type = mimeType.trim().toLowerCase();

    if (type.startsWith("video/")) {
        return { isDocument: false, maxBytes: MAX_CHAT_VIDEO_BYTES };
    }

    if (!isDocumentMimeType(type || "application/octet-stream")) {
        return { isDocument: false, maxBytes: MAX_CHAT_MEDIA_BYTES };
    }

    return { isDocument: true, maxBytes: MAX_EXTRACTION_DOCUMENT_BYTES };
};
