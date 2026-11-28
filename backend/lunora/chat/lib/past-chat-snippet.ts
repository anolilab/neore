import { neutraliseMemoryText } from "@neore/ai/prompts";

import { firstTermIndex } from "./search-terms";

/** Most hits one past-chat search returns; the tool's `limit` is clamped to it. */
export const PAST_CHAT_RESULTS_MAX = 8;
/** Hits returned when the model names no `limit`. */
export const PAST_CHAT_RESULTS_DEFAULT = 5;
/** Most characters of the user's words one hit carries, counted after `<` is escaped (the cut is made on the safe text). */
export const PAST_CHAT_SNIPPET_MAX = 300;
/** Most characters of a chat's title one hit carries, counted after `<` is escaped. */
export const PAST_CHAT_TITLE_MAX = 120;

// Every run of whitespace: the cut below measures and breaks the text as it reads on one line.
const SPACES_RE = /\s+/gu;
// Whitespace or a line break at the end of a piece of text: a word boundary `oneLine` would trim away.
const BREAK_AT_END_RE = /[\s\p{Cc}]$/u;
// The invisible characters `oneLine` drops (`neutraliseMemoryText`): one after the last space leaves that space a boundary.
const INVISIBLE_RE = /\p{Cf}/gu;
// Characters the cut may end on without halving a word, read from the window's edge inwards.
const WORD_EDGE = 24;

/**
 * `index` moved off the middle of a surrogate pair: back before the pair for a cut's end, past it for a cut's start, so an
 * emoji is kept whole or dropped whole. `length` and `slice` count UTF-16 units, so a plain cut can halve one.
 */
export const codePointBoundary = (text: string, index: number, side: "end" | "start"): number => {
    // A code point past U+FFFF starting just before `index` is a pair whose second half `index` would cut off.
    if (index <= 0 || index >= text.length || (text.codePointAt(index - 1) ?? 0) <= 0xff_ff) {
        return index;
    }

    return side === "end" ? index - 1 : index + 1;
};

/** The text on one line, made safe as data by the memory block's sanitiser (`neutraliseMemoryText`), runs of spaces collapsed. */
const oneLine = (text: string): string => neutraliseMemoryText(text).replaceAll(SPACES_RE, " ");

/** A title as a hit carries it: one line, at most {@link PAST_CHAT_TITLE_MAX} characters, `<` escaped. */
export const pastChatTitle = (title: string): string => {
    const line = oneLine(title);

    return line.length > PAST_CHAT_TITLE_MAX ? `${line.slice(0, codePointBoundary(line, PAST_CHAT_TITLE_MAX - 1, "end"))}…` : line;
};

/**
 * The part of `typed` around the first place a query term appears, as one line of at most {@link PAST_CHAT_SNIPPET_MAX}
 * characters (an ellipsis marks each cut end), with `<` escaped. The match is found on `typed` as written, with the
 * index's own terms (`firstTermIndex`): a cleaned copy reads other words (a removed zero-width space joins two, an escaped
 * `<` adds `lt`). The text on each side of it is then made safe apart, so the match's place in the safe line is known, and
 * the cut is made there. When no term is found the excerpt starts at the beginning.
 */
export const pastChatSnippet = (typed: string, terms: ReadonlyArray<string>): string => {
    const whole = oneLine(typed);
    const max = PAST_CHAT_SNIPPET_MAX;

    if (whole.length <= max) {
        return whole;
    }

    const found = Math.max(0, firstTermIndex(typed, terms));
    // Enough of `typed` on each side to fill the excerpt once made safe; what is left out is marked cut.
    const from = codePointBoundary(typed, Math.max(0, found - max), "start");
    const to = codePointBoundary(typed, Math.min(typed.length, found + 2 * max), "end");
    const before = typed.slice(from, found);
    // `oneLine` trims, so the space between the words before the match and the match is put back.
    const head = `${oneLine(before)}${oneLine(before) !== "" && BREAK_AT_END_RE.test(before.replaceAll(INVISIBLE_RE, "")) ? " " : ""}`;
    const line = `${head}${oneLine(typed.slice(found, to))}`;
    const at = head.length;
    const cutBefore = from > 0;
    const cutAfter = to < typed.length;
    // A third of the room before the match, so the words leading up to it read too; each cut end's ellipsis fits in `max`.
    // At most as late as leaves the line's end inside, after a start ellipsis and, when `typed` goes on, an end one.
    let start = Math.max(0, Math.min(at - Math.floor(max / 3), line.length - (max - 1 - (cutAfter ? 1 : 0))));
    const openStart = start > 0 || cutBefore;
    let end = Math.min(line.length, start + max - (openStart ? 1 : 0));
    const openEnd = end < line.length || cutAfter;

    if (openEnd) {
        end = Math.min(end, start + max - (openStart ? 1 : 0) - 1);
    }

    // Move each cut end inwards to a space, when one is near, so no word is halved.
    if (start > 0) {
        const space = line.indexOf(" ", start);

        if (space !== -1 && space - start < WORD_EDGE && space < at) {
            start = space + 1;
        }
    }

    if (end < line.length) {
        const space = line.lastIndexOf(" ", end);

        if (space > start && end - space < WORD_EDGE && space > at) {
            end = space;
        }
    }

    start = codePointBoundary(line, start, "start");
    end = codePointBoundary(line, end, "end");

    return `${openStart ? "…" : ""}${line.slice(start, end).trim()}${openEnd ? "…" : ""}`;
};
