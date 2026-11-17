/**
 * The rule for a `:shortcode` being typed before the caret (`:dog`, `:thumbs_up`).
 *
 * The colon must start the text or follow whitespace, so `12:40`, `https://…`, `::` in code and `word:word` never open
 * the list. The query after it may hold nothing else but `_`, `+` and `-`. It opens the list once it has at least two
 * letters or digits; the two reactions everyone types, `+1` and `-1`, are the one exception: they have a single digit.
 *
 * A shorter query is still a shortcode being typed, so it is reported too (not openable): an Escape on `:dog` must
 * still hold when Backspace leaves `:do` or `:d`.
 */

/** A shortcode being typed: `startOffset` is where its colon sits in the text, `query` what follows it, lower-cased. */
export interface EmojiShortcodeQuery {
    query: string;
    startOffset: number;
}

export const MIN_SHORTCODE_ALPHANUMERICS = 2;

// Hoisted: this runs on every keystroke in the composer.
const WHITESPACE_RE = /\s/;
const SHORTCODE_CHARS_RE = /^[\w+-]*$/;
const ALPHANUMERIC_RE = /[a-z0-9]/gi;
// `:+1:` and `:-1:` are the thumbs up and down; they are too short for the two-character minimum.
const REACTION_QUERIES: ReadonlySet<string> = new Set(["-1", "+1"]);

/** Whether a query is long enough, or is a reaction, for the list to open. */
export const isOpenableShortcodeQuery = (query: string): boolean =>
    (query.match(ALPHANUMERIC_RE)?.length ?? 0) >= MIN_SHORTCODE_ALPHANUMERICS || REACTION_QUERIES.has(query);

/**
 * The shortcode the caret is in, from the text before it in the caret's block, whatever its length: `null` when the
 * caret is in none. Its colon must be in place and its query made of shortcode characters.
 */
export const readEmojiShortcodeToken = (textBefore: string): EmojiShortcodeQuery | null => {
    const colon = textBefore.lastIndexOf(":");

    if (colon === -1) {
        return null;
    }

    if (colon > 0 && !WHITESPACE_RE.test(textBefore.charAt(colon - 1))) {
        return null;
    }

    const query = textBefore.slice(colon + 1);

    if (!SHORTCODE_CHARS_RE.test(query)) {
        return null;
    }

    return { query: query.toLowerCase(), startOffset: colon };
};

/** The shortcode the caret is in, when the list may open for it; `null` otherwise. */
export const findEmojiShortcodeQuery = (textBefore: string): EmojiShortcodeQuery | null => {
    const token = readEmojiShortcodeToken(textBefore);

    return token && isOpenableShortcodeQuery(token.query) ? token : null;
};
