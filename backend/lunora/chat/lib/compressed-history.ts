/**
 * The text that stands in for history `compressContextMessages` folded away, and the taint it carries.
 *
 * Folding tool results and attachments into plain text hides what read them, so the summary's SECOND line
 * records which untrusted sources the folded messages held (`devices/lib/taint.ts` computes it). The line is
 * generated, never copied from message text, and only that exact position is read back: a page that prints a
 * look-alike line inside its own text sits further down and is never parsed.
 */

export const SUMMARY_HEADER = "[Context from earlier in this conversation]";

/** Stands in for the summary when the summary alone would not fit. */
export const DROPPED_SUMMARY_NOTE = "[Earlier conversation was removed to fit the context window]";

const TAINT_LINE = /^\[Compressed content taint: ([a-z]+(?:, [a-z]+)*)\]$/;

/** The line that records the sources of what was folded away; `none` when all of it was our own output. */
export const formatTaintLine = (sources: ReadonlyArray<string>): string => `[Compressed content taint: ${sources.length > 0 ? sources.join(", ") : "none"}]`;

interface MessageLike {
    content?: unknown;
    role?: unknown;
}

/**
 * Whether `message` is a stand-in for compressed history, and the sources it records. `taint` is `undefined` when
 * the message carries no record (history compressed before the record existed), which a caller must treat as unknown.
 */
export const readCompressedHistory = (message: MessageLike): { taint: string[] | undefined } | null => {
    if (message.role !== "user" || typeof message.content !== "string") {
        return null;
    }

    const [first, second] = message.content.split("\n", 2);

    if (first !== SUMMARY_HEADER && first !== DROPPED_SUMMARY_NOTE) {
        return message.content.startsWith(SUMMARY_HEADER) ? { taint: undefined } : null;
    }

    const match = second === undefined ? null : TAINT_LINE.exec(second);

    if (!match) {
        return { taint: undefined };
    }

    return { taint: match[1] === "none" ? [] : match[1]!.split(", ") };
};

/**
 * Whether {@link compressContextMessages} rewrote older history into plain text. Tool results and attachments lose
 * their structure there, so a taint check (`devices/lib/taint.ts`) can no longer see them in what is left.
 */
export const isCompressedHistory = (messages: ReadonlyArray<MessageLike>): boolean => messages.some((message) => readCompressedHistory(message) !== null);
