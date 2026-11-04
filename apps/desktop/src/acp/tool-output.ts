/**
 * What a tool call printed, as the backend shows it on the call's row: the text blocks of its content (the agent's own
 * shell or command tools), or the output of a terminal it ran in (`terminals.ts`). Pure, so the cut is pinned.
 */
import { isRecord, text } from "./child-updates";

/** The most of a call's output the row shows: its tail, in characters (`backend/lunora/acp/validators.ts`). */
export const MAX_TOOL_OUTPUT_CHARS = 2000;

/**
 * The most of a call's raw text kept until it is posted. Masking runs on all of it before the tail is cut, so a value is
 * never half shown at the cut; a value would have to be longer than this, less the tail, to straddle where it is kept.
 */
const MAX_KEPT_CHARS = 64 * 1024;

/**
 * The last `max` characters of `raw`. When that cuts something, the first `secretLength - 1` characters kept go too: a
 * value cut in half at the edge would no longer match the exact-value masking, and what remains of it is at most that long.
 */
export const cutEdge = (raw: string, max: number, secretLength: number): string => {
    if (raw.length <= max) {
        return raw;
    }

    return raw.slice(-max).slice(Math.max(0, secretLength - 1));
};

/**
 * The text of a call's `content`, joined, or undefined when the update carries no content at all (an update without it
 * keeps what the call printed before). Only text blocks count: a diff, an image or a terminal is not printed output.
 */
export const toolTextOf = (content: unknown, secretLength = 0): string | undefined => {
    if (!Array.isArray(content)) {
        return undefined;
    }

    const joined = content
        .map((entry: unknown) => isRecord(entry) && entry.type === "content" && isRecord(entry.content) && entry.content.type === "text" ? text(entry.content.text) : "")
        .filter((piece) => piece !== "")
        .join("\n");

    return cutEdge(joined, MAX_KEPT_CHARS, secretLength);
};

/** The terminal a call's content refers to (`{ type: "terminal", terminalId }`), the first one if there are several. */
export const terminalIdOf = (content: unknown): string | undefined => {
    if (!Array.isArray(content)) {
        return undefined;
    }

    for (const entry of content as unknown[]) {
        if (isRecord(entry) && entry.type === "terminal" && typeof entry.terminalId === "string" && entry.terminalId !== "") {
            return entry.terminalId;
        }
    }

    return undefined;
};

/** What a terminal printed, less the edge the core cut when it kept only the end (see {@link cutEdge}). */
export const cutTerminal = (ended: { output: string; truncated: boolean }, secretLength: number): string =>
    ended.truncated ? ended.output.slice(Math.max(0, secretLength - 1)) : ended.output;

/** The tail a row shows: masked whole first, then cut, so the cut never leaves part of a masked value. */
export const outputTail = (raw: string, scrub: (value: string) => string): string => scrub(raw).slice(-MAX_TOOL_OUTPUT_CHARS);
