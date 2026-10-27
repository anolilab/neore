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
 * and PDF parsing needs ~3× the file size.
 */
export const MAX_EXTRACTION_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** {@link MAX_EXTRACTION_DOCUMENT_BYTES} in whole megabytes, for messages. */
export const MAX_EXTRACTION_DOCUMENT_MEGABYTES = MAX_EXTRACTION_DOCUMENT_BYTES / (1024 * 1024);

/**
 * Above this size a document is extracted as plain text. Markdown output costs
 * roughly twice the memory of plain on a text-dense PDF (87 MiB against 45 MiB at
 * 6 MB), so past about 9 MB it no longer fits the Worker's 128 MiB, while plain
 * text goes on to about 17 MB. A large file keeps what it could always do and
 * loses only its headings and pages.
 */
export const MARKDOWN_EXTRACTION_MAX_BYTES = 5 * 1024 * 1024;

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
 * Reference media: the video and audio a workflow node hands to a generation
 * model (`fal-ai/...` reference-to-video inputs). These are NOT chat
 * attachments: they travel the `reference-media` upload purpose
 * (`lib/upload-route.ts`) and are refused by the chat allowlist. The caps are
 * the reference endpoints' documented limits.
 */
export const REFERENCE_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;
export const REFERENCE_AUDIO_MIME_TYPES = ["audio/mpeg", "audio/wav", "audio/x-wav"] as const;
export const REFERENCE_MEDIA_MIME_TYPES: ReadonlyArray<string> = [...REFERENCE_VIDEO_MIME_TYPES, ...REFERENCE_AUDIO_MIME_TYPES];

/** 50 MiB per reference video. */
export const MAX_REFERENCE_VIDEO_BYTES = 50 * MEGABYTE;

/** 15 MiB per reference audio clip. */
export const MAX_REFERENCE_AUDIO_BYTES = 15 * MEGABYTE;

/** The largest reference upload there is: the cap the upload route declares for every purpose. */
export const MAX_REFERENCE_MEDIA_BYTES = MAX_REFERENCE_VIDEO_BYTES;

const REFERENCE_EXTENSION_TYPES: Readonly<Record<string, string>> = {
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    wav: "audio/wav",
};

/**
 * The reference-media MIME type of a file, or `undefined` when it is not
 * reference media. The declared type wins when it is one of ours; otherwise
 * the extension decides, since browsers report `.wav` under several types and
 * `.mov` under none. The server still checks the real bytes.
 */
export const referenceMediaTypeOf = (fileName: string, declaredType: string): string | undefined => {
    const declared = declaredType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

    if (REFERENCE_MEDIA_MIME_TYPES.includes(declared)) {
        return declared;
    }

    const extension = fileName.includes(".") ? (fileName.split(".").pop()?.toLowerCase() ?? "") : "";

    return REFERENCE_EXTENSION_TYPES[extension];
};

/** The most a reference upload of this MIME type may weigh, or `undefined` when the type is not reference media. */
export const referenceMediaLimitFor = (mimeType: string): number | undefined => {
    if (REFERENCE_VIDEO_MIME_TYPES.includes(mimeType as (typeof REFERENCE_VIDEO_MIME_TYPES)[number])) {
        return MAX_REFERENCE_VIDEO_BYTES;
    }

    if (REFERENCE_AUDIO_MIME_TYPES.includes(mimeType as (typeof REFERENCE_AUDIO_MIME_TYPES)[number])) {
        return MAX_REFERENCE_AUDIO_BYTES;
    }

    return undefined;
};

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
