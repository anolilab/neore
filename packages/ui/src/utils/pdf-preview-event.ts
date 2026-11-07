/**
 * A chat PDF's thumbnail asks the app to open the file in the side panel by dispatching this event on `window`
 * (cancelable). A listener that opens it calls `preventDefault`; with no listener (a shared view, say) the thumbnail
 * falls back to the inline viewer.
 */
export const OPEN_PDF_PREVIEW_EVENT = "neore:open-pdf-preview";

export interface OpenPdfPreviewDetail {
    filename?: string;
    url: string;
}

/**
 * Asks for a PDF preview and reports whether a listener took it. A listener that calls `preventDefault` takes it;
 * with none, the caller shows its own fallback.
 */
export const requestPdfPreview = (detail: OpenPdfPreviewDetail, target: EventTarget = globalThis): boolean =>
    !target.dispatchEvent(new CustomEvent<OpenPdfPreviewDetail>(OPEN_PDF_PREVIEW_EVENT, { cancelable: true, detail }));
