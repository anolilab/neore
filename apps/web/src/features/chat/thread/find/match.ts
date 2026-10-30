/**
 * Pure matching for the thread find bar. It runs over the message data, not the DOM, so a message
 * the list has not mounted (windowed, or not scrolled to) still counts.
 */

/** The longest query searched; a pasted paragraph is not a search. */
export const MAX_FIND_QUERY_LENGTH = 200;

export interface FindableMessage {
    id: string;
    parts: ReadonlyArray<{ text?: string; type: string }>;
    role: string;
    status?: string;
}

export interface FindMatch {
    messageId: string;
    /** Which occurrence within that message, from 0. */
    occurrence: number;
}

const isFenceLine = (line: string): boolean => line.trimStart().startsWith("```") || line.trimStart().startsWith("~~~");

/**
 * The text a reader sees of one markdown part: link targets, code fences, emphasis marks and line prefixes
 * are syntax, not text, so a query is not counted against them.
 */
export const visibleText = (markdown: string): string =>
    markdown
        .split("\n")
        .map((line) => (isFenceLine(line) ? "" : line))
        .join("\n")
        .replaceAll("![", "[")
        .replaceAll(/\[([^[\]]*)\]\([^()]*\)/gu, "$1")
        .replaceAll(/<((?:https?|mailto):[^>\s]+)>/gu, "$1")
        .replaceAll(/`([^`\n]+)`/gu, "$1")
        .replaceAll(/^ {0,3}#{1,6}[ \t]+/gmu, "")
        .replaceAll(/^[ \t]*>[ \t]?/gmu, "")
        .replaceAll(/^[ \t]*(?:[-*+]|\d+[).])[ \t]+/gmu, "")
        .replaceAll(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu, "$2")
        .replaceAll(/\*(?=\S)([^*]+)(?<=\S)\*/gu, "$1")
        .replaceAll(/\b_(?=\S)([^_]+)(?<=\S)_\b/gu, "$1")
        .replaceAll(/~~(.+?)~~/gu, "$1");

/** What a reader sees of a message, one entry per text part: reasoning, tools and files are not searched. */
export const messageTexts = (message: FindableMessage): string[] =>
    message.parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [visibleText(part.text)] : []));

const REGEXP_SPECIALS = /[$()*+.?[\\\]^{|}]/g;

/**
 * Start offsets of every non-overlapping, case-insensitive occurrence of `query` in `text`.
 * Matched on the original text, so offsets stay valid for it (lowercasing can change its length).
 */
export const occurrenceOffsets = (text: string, query: string): number[] => {
    if (query.trim() === "") {
        return [];
    }

    const pattern = new RegExp(query.replaceAll(REGEXP_SPECIALS, String.raw`\$&`), "giu");

    return [...text.matchAll(pattern)].map((match) => match.index);
};

/** Every match in the user and assistant messages, in thread order. */
export const findMatches = (messages: ReadonlyArray<FindableMessage>, query: string): FindMatch[] => {
    const matches: FindMatch[] = [];
    const needle = query.slice(0, MAX_FIND_QUERY_LENGTH);
    const last = messages.at(-1);

    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") {
            continue;
        }

        // The list shows the streaming placeholder instead of the unfinished reply, so it has no row to find.
        if (message === last && message.role === "assistant" && (message.status === "pending" || message.status === "streaming")) {
            continue;
        }

        // Each part is a block of its own on screen, so a match never spans two of them.
        let length = 0;

        for (const text of messageTexts(message)) {
            length += occurrenceOffsets(text, needle).length;
        }

        for (let occurrence = 0; occurrence < length; occurrence += 1) {
            matches.push({ messageId: message.id, occurrence });
        }
    }

    return matches;
};

/** The index one step on, wrapping at either end. `total` of 0 stays at 0. */
export const stepIndex = (current: number, total: number, direction: -1 | 1): number => {
    if (total <= 0) {
        return 0;
    }

    return (current + direction + total) % total;
};

/** The index kept in range when the match list shrinks under it. */
export const clampIndex = (index: number, total: number): number => (total <= 0 ? 0 : Math.min(Math.max(index, 0), total - 1));

/** Most older pages one search pulls in; each page is a live subscription and a socket holds 32. */
export const MAX_FIND_PAGES = 20;
/** Consecutive page requests that added no message before the search gives up (a failing page returns to "can load more"). */
export const MAX_FIND_STALLS = 2;

export interface FindPaging {
    lastCount: number;
    pages: number;
    stalls: number;
}

/** Books one more page request; `stop` is true when this request must not be made. */
export const nextFindPaging = (paging: FindPaging, count: number): { paging: FindPaging; stop: boolean } => {
    const stalls = count > paging.lastCount ? 0 : paging.stalls + 1;

    if (stalls >= MAX_FIND_STALLS || paging.pages >= MAX_FIND_PAGES) {
        return { paging: { ...paging, stalls }, stop: true };
    }

    return { paging: { lastCount: count, pages: paging.pages + 1, stalls }, stop: false };
};
