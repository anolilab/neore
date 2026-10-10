/**
 * File type detection utilities for the file renderer system.
 * Used by all renderers to determine which component should handle a given file.
 */

export type FileRendererType = "audio" | "docx" | "generic" | "image" | "pdf" | "video";

/** Classify a file by its MIME type and/or filename extension. */
export const getFileRendererType = (mediaType?: string, filename?: string): FileRendererType => {
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

    if (isImage(mediaType)) {
        return "image";
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

const getExtension = (filename?: string): string => filename?.split(".").pop()?.toLowerCase() ?? "";

/** Format file size in human-readable units. */
export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;

    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};
