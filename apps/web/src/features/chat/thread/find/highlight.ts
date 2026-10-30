import { occurrenceOffsets } from "./match";

export const MATCH_HIGHLIGHT = "find-match";
export const CURRENT_HIGHLIGHT = "find-current";

const SKIPPED_PARENTS = "script, style, textarea, input";

/** The CSS Custom Highlight API: absent in older engines, where the bar still scrolls and counts. */
export const supportsHighlights = (): boolean => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/**
 * A range per occurrence of `query` inside one text node of `root`. A match split across elements
 * (`foo **bar**`) is not highlighted; the bar still counts and scrolls to it.
 */
export const collectRanges = (root: Node, query: string): Range[] => {
    const ranges: Range[] = [];

    if (query.trim() === "") {
        return ranges;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(SKIPPED_PARENTS)) {
            continue;
        }

        const text = node.textContent ?? "";

        for (const start of occurrenceOffsets(text, query)) {
            const range = document.createRange();

            range.setStart(node, start);
            range.setEnd(node, Math.min(start + query.length, text.length));
            ranges.push(range);
        }
    }

    return ranges;
};

export const setHighlights = (matches: Range[], current: Range | undefined): void => {
    if (!supportsHighlights()) {
        return;
    }

    CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...matches));

    if (current) {
        CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(current));
    } else {
        CSS.highlights.delete(CURRENT_HIGHLIGHT);
    }
};

export const clearHighlights = (): void => {
    if (!supportsHighlights()) {
        return;
    }

    CSS.highlights.delete(MATCH_HIGHLIGHT);
    CSS.highlights.delete(CURRENT_HIGHLIGHT);
};

// Both colours keep text at 4.5:1 or better on their background. The current match is stronger than the rest.
const HIGHLIGHT_CSS = `
:root::highlight(${MATCH_HIGHLIGHT}) { background-color: oklch(0.9 0.12 95); color: oklch(0.2 0 0); }
:root::highlight(${CURRENT_HIGHLIGHT}) { background-color: oklch(0.72 0.17 60); color: oklch(0.15 0 0); }
:root.dark::highlight(${MATCH_HIGHLIGHT}) { background-color: oklch(0.42 0.09 90); color: oklch(0.98 0 0); }
:root.dark::highlight(${CURRENT_HIGHLIGHT}) { background-color: oklch(0.82 0.16 85); color: oklch(0.15 0 0); }
`;

/**
 * Installs the highlight styles as a constructed stylesheet, which an inline-style CSP does not
 * block, and returns the function that removes them.
 */
export const installHighlightStyles = (): (() => void) => {
    if (!supportsHighlights() || typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in document)) {
        return () => {};
    }

    const sheet = new CSSStyleSheet();

    sheet.replaceSync(HIGHLIGHT_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

    return () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((existing) => existing !== sheet);
    };
};
