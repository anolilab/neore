/**
 * Stops a local model reply that has gone wrong: the same line or block
 * repeated over and over, reasoning past its length, or no tokens for a long
 * stretch. Pure: the caller feeds it deltas and arms the idle timer
 * (`run-local-turn.ts`), so the decision table is unit-tested without a stream.
 *
 * The limits are deliberately generous; a stop ends a reply the user may have
 * wanted, and Continue starts it again from the same prompt.
 */

/** A line or block seen this many times in a row ends the reply. */
export const LOCAL_REPEAT_LIMIT = 6;
/** The longest block, in lines, that counts as repeating. */
export const LOCAL_REPEAT_MAX_BLOCK_LINES = 4;
/** A repeated block shorter than this (trimmed, joined) is ignored: `}` or `---` repeat in real code and tables. */
export const LOCAL_REPEAT_MIN_CHARS = 8;
/** No token for this long, counted from the moment the server answers, ends the reply. A model that takes longer than this to produce its first token is stopped too: Continue asks again. */
export const LOCAL_IDLE_TIMEOUT_MS = 120_000;
/** Reasoning text past this many characters ends the reply. */
export const LOCAL_REASONING_LIMIT_CHARS = 30_000;

export type ReplyStopKind = "idle" | "reasoning-limit" | "repeat-loop";

const REPLY_STOP_KINDS: ReadonlyArray<ReplyStopKind> = ["idle", "reasoning-limit", "repeat-loop"];

export const isReplyStopKind = (kind: string): kind is ReplyStopKind => (REPLY_STOP_KINDS as ReadonlyArray<string>).includes(kind);

const TRAILING_CR = /\r$/u;

/** The completed lines the repeat check can still see: enough for the longest block repeated the limit's times. */
const WINDOW_LINES = LOCAL_REPEAT_LIMIT * LOCAL_REPEAT_MAX_BLOCK_LINES;

/** Whether the last `size` lines are one block repeated {@link LOCAL_REPEAT_LIMIT} times in a row. */
const repeatsAtTail = (lines: ReadonlyArray<string>, size: number): boolean => {
    const span = size * LOCAL_REPEAT_LIMIT;

    if (lines.length < span) {
        return false;
    }

    const start = lines.length - span;
    const block = lines.slice(start, start + size);

    if (block.map((line) => line.trim()).join("\n").length < LOCAL_REPEAT_MIN_CHARS) {
        return false;
    }

    for (let copy = 1; copy < LOCAL_REPEAT_LIMIT; copy += 1) {
        for (let index = 0; index < size; index += 1) {
            if (lines[start + copy * size + index] !== block[index]) {
                return false;
            }
        }
    }

    return true;
};

/** A repeat found in a content delta: keep the delta's first `keep` characters, through the newline that completed the repeat. */
export interface ContentStop {
    keep: number;
    kind: "repeat-loop";
}

/** Reasoning past the limit: keep the delta's first `keep` characters, which bring the total to exactly the limit. */
export interface ReasoningStop {
    keep: number;
    kind: "reasoning-limit";
}

export interface ReplyGuard {
    /** Feed visible reply text; returns the stop, and where in this delta the reply ends, once it repeats. */
    pushContent: (text: string) => ContentStop | undefined;
    /** Feed reasoning text; returns the stop, and how much of this delta fits under the limit, once it passes. */
    pushReasoning: (text: string) => ReasoningStop | undefined;
}

export const createReplyGuard = (): ReplyGuard => {
    // The unfinished line; only completed lines take part in the repeat check.
    let partial = "";
    let lines: string[] = [];
    let reasoningChars = 0;

    return {
        pushContent: (text) => {
            let offset = 0;
            let newline = text.indexOf("\n");

            while (newline !== -1) {
                partial += text.slice(offset, newline);
                offset = newline + 1;
                newline = text.indexOf("\n", offset);

                // Indentation and trailing spaces are part of a line (a Markdown hard break is one): only a CR from CRLF is dropped.
                // A blank line stays in the window as a line: lines that are not next to each other are not one run.
                const line = partial.replace(TRAILING_CR, "");

                partial = "";
                lines.push(line);

                if (lines.length > WINDOW_LINES) {
                    lines = lines.slice(-WINDOW_LINES);
                }

                for (let size = 1; size <= LOCAL_REPEAT_MAX_BLOCK_LINES; size += 1) {
                    if (repeatsAtTail(lines, size)) {
                        return { keep: offset, kind: "repeat-loop" };
                    }
                }
            }

            partial += text.slice(offset);

            return undefined;
        },
        pushReasoning: (text) => {
            const room = Math.max(LOCAL_REASONING_LIMIT_CHARS - reasoningChars, 0);

            reasoningChars += text.length;

            return reasoningChars > LOCAL_REASONING_LIMIT_CHARS ? { keep: Math.min(room, text.length), kind: "reasoning-limit" } : undefined;
        },
    };
};
