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
}

export interface FindMatch {
    messageId: string;
    /** Which occurrence within that message, from 0. */
    occurrence: number;
}

/** What a reader sees of a message: its text parts, in order. Reasoning, tools and files are not searched. */
export const messageText = (message: FindableMessage): string =>
    message.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");

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

    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") {
            continue;
        }

        const { length } = occurrenceOffsets(messageText(message), query.slice(0, MAX_FIND_QUERY_LENGTH));

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
