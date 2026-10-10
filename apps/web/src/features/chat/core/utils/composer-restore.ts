/**
 * "Restore to input" — puts a sent user message's text and attachments back
 * into the composer so it can be edited and sent as a NEW message (unlike
 * "Edit", which rewrites history).
 *
 * The message action lives in the thread, the upload pipeline in the composer,
 * and neither is a child of the other, so the request crosses a typed request
 * channel (`core/stores/request-channel-store.ts`).
 */

import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";

import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";

export interface ComposerRestoreFile {
    filename?: string;
    mediaType: string;
    url: string;
}

export interface ComposerRestorePayload {
    files: ComposerRestoreFile[];
    text: string;
}

interface RestorableMessage {
    parts: ReadonlyArray<{ filename?: string; mediaType?: string; providerMetadata?: unknown; text?: string; type: string; url?: string }>;
    text?: string;
}

const DATA_URL_PATTERN = /^data:([^;,]*)(?:;[^;,]*)*?(;base64)?,(.*)$/s;

export const extractComposerRestorePayload = (message: RestorableMessage): ComposerRestorePayload => {
    const files: ComposerRestoreFile[] = [];

    for (const part of message.parts) {
        if (part.type === "file" && part.url) {
            files.push({ filename: part.filename, mediaType: part.mediaType || "application/octet-stream", url: part.url });
        }
    }

    // Only what the user typed: an attached web page (a marked text part) is
    // not composer text, and pasting its wrapped JSON back would be wrong.
    return { files, text: getVisibleUserText({ parts: [...message.parts], text: message.text }) };
};

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
    "application/pdf": "pdf",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "text/markdown": "md",
    "text/plain": "txt",
};

export const restoreFileName = (file: ComposerRestoreFile, index: number): string => {
    if (file.filename) {
        return file.filename;
    }

    const extension = EXTENSION_BY_MEDIA_TYPE[file.mediaType] ?? file.mediaType.split("/", 2)[1]?.replaceAll(/[^a-z0-9]/gi, "") ?? "bin";

    return `attachment-${index + 1}.${extension || "bin"}`;
};

/**
 * Decodes a `data:` URL without `fetch` — the app's CSP `connect-src` does not
 * list `data:`, so fetching one is blocked. Returns `null` for anything else.
 */
export const decodeDataUrl = (url: string): Blob | null => {
    const match = DATA_URL_PATTERN.exec(url);

    if (!match) {
        return null;
    }

    const [, mediaType, base64, data = ""] = match;

    if (base64) {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.codePointAt(index) ?? 0;
        }

        return new Blob([bytes], { type: mediaType || "application/octet-stream" });
    }

    return new Blob([decodeURIComponent(data)], { type: mediaType || "text/plain" });
};

/** Loads a restorable file as a `File` the composer's upload pipeline can take. */
export const loadRestoreFile = async (file: ComposerRestoreFile, index: number): Promise<File> => {
    const name = restoreFileName(file, index);
    let blob = decodeDataUrl(file.url);

    if (!blob) {
        const response = await fetch(file.url);

        if (!response.ok) {
            await response.body?.cancel();

            throw new Error(`Failed to load ${name}: HTTP ${response.status}`);
        }

        blob = await response.blob();
    }

    return new File([blob], name, { type: file.mediaType || blob.type });
};

const composerRestoreChannel = createRequestChannel<ComposerRestorePayload>();

export const requestComposerRestore = (payload: ComposerRestorePayload): void => {
    composerRestoreChannel.request(payload);
};

/**
 * Subscribes to restore requests — including one made before the composer
 * mounted — and returns the unsubscribe function.
 */
export const onComposerRestore = (handler: (payload: ComposerRestorePayload) => void): (() => void) => composerRestoreChannel.consume(handler);
