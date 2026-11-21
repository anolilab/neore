import type { MouseEvent } from "react";

/**
 * Saving a file a link points at, under its own name.
 *
 * A browser ignores `<a download>` on a cross-origin link, and the app's files are served from the backend's origin
 * (signed storage URLs). So a plain download link saves a file under a random name, and an image, PDF or text file
 * opens in a tab instead of saving. These helpers fetch the file into a blob first, which is same-origin, so the name
 * holds. When the fetch fails (no CORS for this origin, a network error), the URL is opened in a new tab and the
 * browser decides between showing and saving it, as the plain link did.
 */

/** A name that already ends in an extension. */
const HAS_EXTENSION = /\.[a-z0-9]{1,8}$/iu;

/** The extension a saved file gets from its type when its name has none. */
const EXTENSION_BY_TYPE: Record<string, string> = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/csv": "csv",
    "text/markdown": "md",
    "text/plain": "txt",
    "video/mp4": "mp4",
    "video/webm": "webm",
};

/**
 * The name to save a file under: `filename` when it is given, else `fallback`, with the extension its type maps to when
 * the name has none. Pure; pinned by `save-from-url.test.ts`.
 */
export const saveName = (filename: string | undefined, type: string | undefined, fallback = "download"): string => {
    const name = filename?.trim() || fallback;

    if (HAS_EXTENSION.test(name)) {
        return name;
    }

    const extension = type ? EXTENSION_BY_TYPE[type.split(";", 1)[0]?.trim().toLowerCase() ?? ""] : undefined;

    return extension ? `${name}.${extension}` : name;
};

const clickAnchor = (href: string, filename: string, newTab: boolean): void => {
    const anchor = document.createElement("a");

    anchor.href = href;
    anchor.download = filename;
    anchor.rel = "noopener noreferrer";

    if (newTab) {
        anchor.target = "_blank";
    }

    // `appendChild`, not `append`: with the Workers types in scope, `append` resolves to an overload that rejects an element.
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
};

const fetchBlob = async (url: string): Promise<Blob | undefined> => {
    try {
        const response = await fetch(url);

        if (!response.ok) {
            await response.body?.cancel();

            return undefined;
        }

        return await response.blob();
    } catch {
        return undefined;
    }
};

/** Saves the file at `url` as `filename` (see the module comment for why it is fetched first). */
export const saveFromUrl = async (url: string, filename?: string, fallbackName?: string): Promise<void> => {
    const blob = await fetchBlob(url);

    if (!blob) {
        clickAnchor(url, saveName(filename, undefined, fallbackName), true);

        return;
    }

    const blobUrl = URL.createObjectURL(blob);

    clickAnchor(blobUrl, saveName(filename, blob.type, fallbackName), false);
    // Revoked on the next task: the click has already handed the blob to the download.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
};

/**
 * An `onClick` for a download link (`<a download href>`): a plain click saves the file under `filename` through
 * {@link saveFromUrl}; a click with a modifier or another button (open in a new tab or window) keeps the link's own
 * behaviour, and so does a link with no URL.
 */
export const saveOnClick =
    (url: string | undefined, filename?: string, fallbackName?: string) =>
    (event: MouseEvent<HTMLAnchorElement>): void => {
        if (!url || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
        }

        event.preventDefault();
        // It does not reject: a failed fetch falls back to opening the URL.
        saveFromUrl(url, filename, fallbackName).catch(() => undefined);
    };
