import type { MouseEvent } from "react";

/**
 * Saving a file a link points at, under its own name.
 *
 * A browser ignores `<a download>` on a cross-origin link, and the app's files are served from the backend's origin
 * (signed storage URLs). So a plain download link saves a file under a random name, and an image, PDF or text file
 * opens in a tab instead of saving. These helpers fetch the file into a blob first, which is same-origin, so the name
 * holds. When the fetch fails (no CORS for this origin, a network error, no answer within `HEADERS_DEADLINE_MS`), the
 * URL is opened in a new tab and the browser decides between showing and saving it, as the plain link did.
 *
 * Any origin is fetched, since the signed storage URLs are cross-origin by design: the fetch reaches only the URL the
 * link itself opens, without cookies (another origin) or a referrer.
 */

/** A name that already ends in an extension. */
const HAS_EXTENSION = /\.[a-z0-9]{1,16}$/iu;

/** The extension a saved file gets from its type when its name has none. */
const EXTENSION_BY_TYPE: Record<string, string> = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/zip": "zip",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
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
    "video/ogg": "ogv",
    "video/quicktime": "mov",
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

/** The schemes a file is fetched from. Anything else (`javascript:`, `file:`, …) is neither fetched nor opened. */
const FETCHABLE_PROTOCOLS = new Set(["blob:", "data:", "http:", "https:"]);

const isFetchable = (url: string): boolean => {
    try {
        return FETCHABLE_PROTOCOLS.has(new URL(url, document.baseURI).protocol);
    } catch {
        return false;
    }
};

/** The schemes an image download link may point at besides a `data:` raster image. */
const LINKABLE_PROTOCOLS = new Set(["blob:", "http:", "https:"]);

/** A `data:` URL of a raster image: no SVG, which can carry script when opened on its own. */
const DATA_RASTER_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]/iu;

/**
 * `url` when a link may point at it as an image download (http(s), `blob:`, or a `data:` raster image), else
 * `undefined`. A link's own navigation (a click with a modifier, "open in new tab") skips `saveOnClick`, so a link to
 * a value a message could carry (`javascript:`, an HTML or SVG `data:` URL) must not be rendered at all.
 */
export const safeImageDownloadUrl = (url: string): string | undefined => {
    const trimmed = url.trim();
    let protocol: string;

    // The scheme as the browser reads it: `DATA:` or a leading space is still `data:` to a link.
    try {
        protocol = new URL(trimmed, document.baseURI).protocol;
    } catch {
        return undefined;
    }

    if (protocol === "data:") {
        return DATA_RASTER_IMAGE.test(trimmed) ? trimmed : undefined;
    }

    return LINKABLE_PROTOCOLS.has(protocol) ? trimmed : undefined;
};

/**
 * How long the response headers may take. The fallback opens a tab, which a browser allows only while the click's user
 * activation lasts (about a second in Safari, five in Chrome and Firefox), so a fetch that has not answered by then
 * gives way to it. The body is not under this deadline: saving a blob needs no activation.
 */
export const HEADERS_DEADLINE_MS = 1000;

/** URLs being saved right now: a second click on one does not start a second transfer. */
const savesInFlight = new Set<string>();

/** How `saveFromUrl` waits for the file. */
export interface SaveOptions {
    /**
     * How long the response headers may take before the save gives way to the new tab; `null` waits for them. Default
     * {@link HEADERS_DEADLINE_MS}, for a save started by the click itself. A caller that awaits something first (the
     * vault asks for the link) has spent the click's activation already, so it waits instead.
     */
    headersDeadlineMs?: number | null;
}

const fetchBlob = async (url: string, headersDeadlineMs: number | null): Promise<Blob | undefined> => {
    const controller = new AbortController();
    const deadline = headersDeadlineMs === null ? undefined : setTimeout(() => controller.abort(), headersDeadlineMs);

    try {
        const response = await fetch(url, { referrerPolicy: "no-referrer", signal: controller.signal });

        clearTimeout(deadline);

        if (!response.ok) {
            await response.body?.cancel();

            return undefined;
        }

        return await response.blob();
    } catch {
        return undefined;
    } finally {
        clearTimeout(deadline);
    }
};

/**
 * Saves the file at `url` as `filename` (see the module comment for why it is fetched first). A URL of another scheme
 * than http(s), blob or data is left alone, and so is a second save of a URL still being fetched.
 */
export const saveFromUrl = async (url: string, filename?: string, fallbackName?: string, options: SaveOptions = {}): Promise<void> => {
    if (!isFetchable(url) || savesInFlight.has(url)) {
        return;
    }

    savesInFlight.add(url);

    try {
        const blob = await fetchBlob(url, options.headersDeadlineMs === undefined ? HEADERS_DEADLINE_MS : options.headersDeadlineMs);

        if (!blob) {
            clickAnchor(url, saveName(filename, undefined, fallbackName), true);

            return;
        }

        const blobUrl = URL.createObjectURL(blob);

        clickAnchor(blobUrl, saveName(filename, blob.type, fallbackName), false);
        // Revoked on the next task: the click has already handed the blob to the download.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } finally {
        savesInFlight.delete(url);
    }
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
