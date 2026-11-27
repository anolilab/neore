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
// Characters the cut may end on without halving a word, read from the window's edge inwards.
const WORD_EDGE = 24;

/** The text on one line, made safe as data by the memory block's sanitiser (`neutraliseMemoryText`), runs of spaces collapsed. */
const oneLine = (text: string): string => neutraliseMemoryText(text).replaceAll(SPACES_RE, " ");

/** A title as a hit carries it: one line, at most {@link PAST_CHAT_TITLE_MAX} characters, `<` escaped. */
export const pastChatTitle = (title: string): string => {
    const line = oneLine(title);

    return line.length > PAST_CHAT_TITLE_MAX ? `${line.slice(0, PAST_CHAT_TITLE_MAX - 1)}…` : line;
};

/**
 * The part of `typed` around the first place a query term appears, as one line of at most {@link PAST_CHAT_SNIPPET_MAX}
 * characters (an ellipsis marks each cut end), with `<` escaped. A term is found as the index finds it (case and accents
 * folded, `cafe` finds `café`); when none is found the excerpt starts at the beginning.
 */
export const pastChatSnippet = (typed: string, terms: ReadonlyArray<string>): string => {
    const line = oneLine(typed);
    const max = PAST_CHAT_SNIPPET_MAX;

    if (line.length <= max) {
        return line;
    }

    const at = Math.max(0, firstTermIndex(line, terms));
    // A third of the room before the match, so the words leading up to it read too; both ellipses fit inside `max`.
    let start = Math.max(0, Math.min(at - Math.floor(max / 3), line.length - (max - 1)));
    let end = Math.min(line.length, start + max - (start > 0 ? 1 : 0));

    if (end < line.length) {
        end -= 1;
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

        if (space > start && end - space < WORD_EDGE) {
            end = space;
        }
    }

    return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
};
