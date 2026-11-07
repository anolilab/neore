/**
 * A chat PDF's thumbnail asks the app to open the file in the side panel by dispatching this event on `window`
 * (cancelable). A listener that opens it calls `preventDefault`; with no listener (a shared view, say) the thumbnail
 * falls back to the inline viewer.
 */
export const OPEN_PDF_PREVIEW_EVENT = "neore:open-pdf-preview";

export interface OpenPdfPreviewDetail {
    filename?: string;
    /** The control that asked, so focus can return to it when the panel closes. */
    opener?: HTMLElement;
    url: string;
}

/**
 * Asks for a PDF preview and reports whether a listener took it. A listener that calls `preventDefault` takes it;
 * with none, the caller shows its own fallback.
 */
export const requestPdfPreview = (detail: OpenPdfPreviewDetail, target: EventTarget = globalThis): boolean =>
    !target.dispatchEvent(new CustomEvent<OpenPdfPreviewDetail>(OPEN_PDF_PREVIEW_EVENT, { cancelable: true, detail }));

/** A signed URL's identity: the same file signed again has the same origin and path, and a new signature. */
const fileKey = (url: string): string => {
    try {
        const parsed = new URL(url);

        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
};

/** Files whose newest URL is kept: a thread shows a few PDFs, so the oldest are dropped well before this is reached. */
const MAX_REMEMBERED_FILES = 200;
const latestUrls = new Map<string, string>();

/** Records the newest signed URL of a PDF on screen, so a panel opened with an older one can follow it. */
export const rememberPdfUrl = (url: string): void => {
    const key = fileKey(url);

    latestUrls.delete(key);
    latestUrls.set(key, url);

    const oldest = latestUrls.size > MAX_REMEMBERED_FILES ? latestUrls.keys().next().value : undefined;

    if (oldest !== undefined) {
        latestUrls.delete(oldest);
    }
};

/** The newest URL seen for the same file as `url`, or `url` itself: a signed URL expires, and its message re-signs it. */
export const latestPdfUrl = (url: string): string => latestUrls.get(fileKey(url)) ?? url;
