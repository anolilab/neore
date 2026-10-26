/**
 * File type detection utilities for the file renderer system.
 * Used by all renderers to determine which component should handle a given file.
 */

export type FileRendererType = "audio" | "docx" | "generic" | "image" | "jsonl" | "mermaid" | "pdf" | "table" | "video";

/**
 * Text files that get a preview of their own, recognised by name: the chat
 * stores them as `text/plain`, so the type says nothing. The one list the
 * predicates below, the composer's `accept` string and its upload type are
 * derived from.
 */
export const TEXT_PREVIEW_EXTENSIONS = {
    jsonl: ["jsonl", "ndjson"],
    mermaid: ["mermaid", "mmd"],
    table: ["csv", "tsv"],
} as const;

const getExtension = (filename?: string): string => filename?.split(".").pop()?.toLowerCase() ?? "";

const hasExtension = (filename: string | undefined, extensions: ReadonlyArray<string>): boolean => extensions.includes(getExtension(filename));

/** JSON Lines / NDJSON: one JSON value per line. */
export const isJsonl = (filename?: string): boolean => hasExtension(filename, TEXT_PREVIEW_EXTENSIONS.jsonl);

/** A Mermaid diagram source. */
export const isMermaid = (filename?: string): boolean => hasExtension(filename, TEXT_PREVIEW_EXTENSIONS.mermaid);

/** Delimited tables: comma- or tab-separated (`.csv`, `.tsv`). */
export const isDelimitedTable = (filename?: string): boolean => hasExtension(filename, TEXT_PREVIEW_EXTENSIONS.table);

/** A name alone is not enough: a binary called `data.csv` must not be fetched and parsed as text. */
const isTextLikeType = (mediaType?: string): boolean => !mediaType || mediaType.startsWith("text/") || mediaType === "application/octet-stream";

/** Classify a file by its MIME type and/or filename extension. */
export const getFileRendererType = (mediaType?: string, filename?: string): FileRendererType => {
    if (isImage(mediaType)) {
        return "image";
    }

    if (isPdf(mediaType, filename)) {
        return "pdf";
    }

    if (isVideo(mediaType, filename)) {
        return "video";
    }

    if (isAudio(mediaType, filename)) {
        return "audio";
    }

    if (isDocx(mediaType, filename)) {
        return "docx";
    }

    // Older uploads of a JSON Lines file carry application/json, which the chat allowlist accepts.
    if (isJsonl(filename) && (isTextLikeType(mediaType) || mediaType === "application/json")) {
        return "jsonl";
    }

    if (isTextLikeType(mediaType)) {
        if (isMermaid(filename)) {
            return "mermaid";
        }

        if (isDelimitedTable(filename)) {
            return "table";
        }
    }

    return "generic";
};

export const isPdf = (mediaType?: string, filename?: string): boolean => mediaType === "application/pdf" || filename?.toLowerCase().endsWith(".pdf") === true;

export const isVideo = (mediaType?: string, filename?: string): boolean => {
    if (mediaType?.startsWith("video/")) {
        return true;
    }

    if (mediaType === "application/vnd.apple.mpegurl") {
        return true;
    }

    const extension = getExtension(filename);

    return ["avi", "m3u8", "mkv", "mov", "mp4", "ogg", "webm"].includes(extension);
};

export const isAudio = (mediaType?: string, filename?: string): boolean => {
    if (mediaType?.startsWith("audio/")) {
        return true;
    }

    const extension = getExtension(filename);

    return ["aac", "flac", "m4a", "mp3", "ogg", "wav", "webm"].includes(extension);
};

export const isDocx = (mediaType?: string, filename?: string): boolean =>
    mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || filename?.toLowerCase().endsWith(".docx") === true;

export const isImage = (mediaType?: string): boolean => mediaType?.startsWith("image/") === true;

/** Format file size in human-readable units. */
export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;

    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};
