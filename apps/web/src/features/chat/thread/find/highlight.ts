import { occurrenceOffsets } from "./match";

/**
 * The CSS Custom Highlight names one find bar paints under. The registry is document-wide, so each bar owns its own
 * pair: a bar sets and clears only its names, and two open bars never overwrite or clear each other's highlights.
 */
export interface HighlightNames {
    current: string;
    match: string;
}

/** The thread's find bar. Its names are the defaults, so its calls are unchanged. */
const THREAD_HIGHLIGHTS: HighlightNames = { current: "find-current", match: "find-match" };

/** The side-question find bar (`chat/aside/find`). */
export const ASIDE_HIGHLIGHTS: HighlightNames = { current: "aside-find-current", match: "aside-find-match" };

const SKIPPED_PARENTS = "script, style, textarea, input";

/** The CSS Custom Highlight API: absent in older engines, where the bar still scrolls and counts. */
export const supportsHighlights = (): boolean => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** Marks the container of one rendered text part (`message-content.tsx`): tool labels and output stay outside it. */
export const FIND_TEXT_SELECTOR = "[data-find-text]";

/**
 * A range per occurrence of `query` inside one text node of a text part under `root`, in part order. Text under an
 * element matching `skipped` is left out: a find that paints only what it counts passes the controls a part renders
 * (`button`, for one) so their labels are neither counted nor painted. A match split across elements (`foo **bar**`)
 * is not found, so it is neither counted nor painted.
 */
export const collectRanges = (root: Node, query: string, skipped: string = SKIPPED_PARENTS): Range[] => {
    const ranges: Range[] = [];

    if (query.trim() === "") {
        return ranges;
    }

    const containers = root instanceof Element ? root.querySelectorAll(FIND_TEXT_SELECTOR) : [];

    for (const container of containers) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest(skipped)) {
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
    }

    return ranges;
};

export const setHighlights = (matches: Range[], current: Range | undefined, names: HighlightNames = THREAD_HIGHLIGHTS): void => {
    if (!supportsHighlights()) {
        return;
    }

    CSS.highlights.set(names.match, new Highlight(...matches));

    if (current) {
        CSS.highlights.set(names.current, new Highlight(current));
    } else {
        CSS.highlights.delete(names.current);
    }
};

export const clearHighlights = (names: HighlightNames = THREAD_HIGHLIGHTS): void => {
    if (!supportsHighlights()) {
        return;
    }

    CSS.highlights.delete(names.match);
    CSS.highlights.delete(names.current);
};

/** Both colours keep text at 4.5:1 or better on their background. The current match is stronger than the rest. */
const highlightCss = ({ current, match }: HighlightNames): string => `
:root::highlight(${match}) { background-color: oklch(0.9 0.12 95); color: oklch(0.2 0 0); }
:root::highlight(${current}) { background-color: oklch(0.72 0.17 60); color: oklch(0.15 0 0); }
:root.dark::highlight(${match}) { background-color: oklch(0.42 0.09 90); color: oklch(0.98 0 0); }
:root.dark::highlight(${current}) { background-color: oklch(0.82 0.16 85); color: oklch(0.15 0 0); }
`;

/**
 * Installs the highlight styles as a constructed stylesheet, which an inline-style CSP does not
 * block, and returns the function that removes them.
 */
export const installHighlightStyles = (names: HighlightNames = THREAD_HIGHLIGHTS): (() => void) => {
    if (!supportsHighlights() || typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in document)) {
        return () => {};
    }

    const sheet = new CSSStyleSheet();

    sheet.replaceSync(highlightCss(names));
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

    return () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((existing) => existing !== sheet);
    };
};
