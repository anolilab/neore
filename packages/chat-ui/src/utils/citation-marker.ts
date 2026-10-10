/**
 * The inline `[n]` citation markers `MessageContent` injects into rendered
 * text. Plain DOM, because they are spliced into Streamdown's output after it
 * renders.
 */

const MARKER_CLASS =
    "ml-0.5 inline-flex size-4 cursor-pointer items-center justify-center rounded-full bg-gray-200 text-[9px] font-bold text-gray-600 no-underline align-super transition-colors hover:bg-blue-100 hover:text-blue-700 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-blue-900 dark:hover:text-blue-300";

/**
 * `url` when it is an absolute http(s) URL, else `undefined`. A source URL
 * comes from a tool result or the model, so a `javascript:` or `data:` one
 * must never become a link.
 */
export const safeHttpUrl = (url: string): string | undefined => {
    try {
        const { protocol } = new URL(url);

        return protocol === "http:" || protocol === "https:" ? url : undefined;
    } catch {
        return undefined;
    }
};

/**
 * A marker for source `index`. A web source links out; any other (a document
 * source, or a URL that is not http(s)) is a button that opens the matching
 * chip through `data-citation-opens` — the caller's delegated click handler.
 */
export const createCitationMarker = (document_: Document, { index, label, url }: { index: number; label: string; url: string }): HTMLElement => {
    const href = safeHttpUrl(url);
    let marker: HTMLElement;

    if (href) {
        const link = document_.createElement("a");

        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        marker = link;
    } else {
        const button = document_.createElement("button");

        button.type = "button";
        button.dataset.citationOpens = String(index);
        marker = button;
    }

    marker.setAttribute("aria-label", label);
    marker.dataset.citation = String(index);
    marker.className = MARKER_CLASS;
    marker.textContent = String(index);

    return marker;
};
