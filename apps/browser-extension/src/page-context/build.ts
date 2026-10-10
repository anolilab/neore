import type { PageContext } from "@neore/ai/gateway";

import type { RawPageContent } from "./extract";

/**
 * The `pageContext` field of the `/v1/chat` start payload, shared with the
 * backend through `@neore/ai/gateway`. The backend
 * (`backend/lunora/chat/lib/page-context.ts`) validates it and wraps it as
 * untrusted data before it reaches the model. Keep the budgets below at or
 * under that file's `PAGE_CONTEXT_LIMITS` — the backend rejects, rather than
 * truncates, anything over its caps.
 */
export type { PageContext } from "@neore/ai/gateway";

/**
 * Character budgets. ~4 characters per token, so the page text is roughly 6k
 * tokens: enough for an article, small enough to leave the model's context
 * for the conversation and the answer.
 */
export const PAGE_CONTEXT_BUDGET = {
    selection: 4000,
    text: 24_000,
    title: 300,
    url: 2048,
} as const;

/** Upper bound on what the injected extractor sends back, before budgeting. */
export const EXTRACTION_TRANSFER_CAP = 200_000;

export const TRUNCATION_MARKER = "\n\n[… page truncated]";

/** The whitespace before the last word: the latest word boundary in a window. */
const LAST_WORD_BOUNDARY = /\s\S*$/;

/** Collapse runs of spaces and blank lines, normalise line endings. */
export const normalizeText = (value: string): string =>
    value
        .replaceAll(/\r\n?/g, "\n")
        .replaceAll(/[^\S\n]+/g, " ")
        // The line above left at most one space on either side of a newline.
        .replaceAll(/ ?\n ?/g, "\n")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim();

/**
 * Cut `value` to at most `maxChars` characters, marker included.
 *
 * Prefers to end on a paragraph break, then a sentence end, then a word
 * boundary — as long as that boundary is in the last fifth of the window, so a
 * single early break cannot throw most of the budget away.
 */
export const truncateToBudget = (value: string, maxChars: number, marker = TRUNCATION_MARKER): { text: string; truncated: boolean } => {
    if (value.length <= maxChars) {
        return { text: value, truncated: false };
    }

    const room = Math.max(0, maxChars - marker.length);
    const window = value.slice(0, room);
    const floor = Math.floor(room * 0.8);

    const paragraph = window.lastIndexOf("\n\n");
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf(".\n"));
    const word = window.search(LAST_WORD_BOUNDARY);

    let cut = room;

    if (paragraph >= floor) {
        cut = paragraph;
    } else if (sentence >= floor) {
        cut = sentence + 1;
    } else if (word >= floor) {
        cut = word;
    }

    return { text: `${window.slice(0, cut).trimEnd()}${marker}`, truncated: true };
};

/**
 * Only http(s), with any `user:password@` removed and the fragment dropped —
 * the fragment is client-side state the model has no use for, and credentials
 * in a URL must never leave the browser.
 */
export const sanitizePageUrl = (value: string): string | undefined => {
    try {
        const url = new URL(value);

        if (url.protocol !== "https:" && url.protocol !== "http:") {
            return undefined;
        }

        url.username = "";
        url.password = "";
        url.hash = "";

        const { href } = url;

        return href.length <= PAGE_CONTEXT_BUDGET.url ? href : undefined;
    } catch {
        return undefined;
    }
};

export class PageContextError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PageContextError";
    }
}

/**
 * Turn raw extractor output (or a context-menu selection) into the payload the
 * backend accepts: normalised, budgeted, with a safe URL. Throws
 * `PageContextError` when nothing usable is left.
 */
export const buildPageContext = (raw: Partial<RawPageContent> & { url: string }, options: { includeText?: boolean } = {}): PageContext => {
    const url = sanitizePageUrl(raw.url);

    if (!url) {
        throw new PageContextError("This page cannot be shared: only http and https pages are supported.");
    }

    const title =
        normalizeText(raw.title ?? "")
            .replaceAll("\n", " ")
            .slice(0, PAGE_CONTEXT_BUDGET.title) || new URL(url).hostname;
    const selection = truncateToBudget(normalizeText(raw.selection ?? ""), PAGE_CONTEXT_BUDGET.selection, "\n\n[… selection truncated]").text;
    const text = options.includeText === false ? "" : truncateToBudget(normalizeText(raw.text ?? ""), PAGE_CONTEXT_BUDGET.text).text;

    if (!selection && !text) {
        throw new PageContextError("No readable text was found on this page.");
    }

    return {
        ...(selection && { selection }),
        ...(text && { text }),
        title,
        url,
    };
};

/** Rough token estimate for the UI (4 characters ≈ 1 token). */
export const estimateTokens = (context: PageContext): number => Math.ceil(((context.text?.length ?? 0) + (context.selection?.length ?? 0)) / 4);
