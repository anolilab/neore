/**
 * Ranking for the emoji shortcode list: prefix matches on a shortcode first, then substring matches, one row per emoji.
 *
 * The index is sorted once, shortest shortcode first, so each tier comes out shortest-first without a sort per keystroke.
 */

/** One emoji and the shortcodes it goes by, as the emoji data lists them (`["+1", "thumbsup"]`). */
export interface EmojiEntry {
    readonly emoji: string;
    readonly shortcodes: ReadonlyArray<string>;
}

interface IndexedShortcode {
    readonly emoji: string;
    /** Lower-cased for matching; `shortcode` keeps the spelling the list shows. */
    readonly lower: string;
    readonly shortcode: string;
}

export type EmojiIndex = ReadonlyArray<IndexedShortcode>;

export interface EmojiSuggestion {
    readonly emoji: string;
    /** Where the typed query starts inside `shortcode`: 0 for a prefix match. */
    readonly matchIndex: number;
    /** Length of the typed query, the part of `shortcode` the row shows in bold. */
    readonly matchLength: number;
    readonly shortcode: string;
}

export const EMOJI_SUGGESTION_LIMIT = 8;

export const buildEmojiIndex = (entries: ReadonlyArray<EmojiEntry>): EmojiIndex =>
    entries
        .flatMap(({ emoji, shortcodes }) =>
            shortcodes.map((shortcode) => {
                return { emoji, lower: shortcode.toLowerCase(), shortcode };
            }),
        )
        .toSorted((a, b) => a.shortcode.length - b.shortcode.length);

/**
 * The emoji whose shortcodes start with `query`, then the rest whose shortcodes contain it. An emoji with several
 * matching shortcodes is listed once, under its shortest match. Stops at `limit` rows.
 */
export const searchEmojiShortcodes = (index: EmojiIndex, query: string, limit: number = EMOJI_SUGGESTION_LIMIT): EmojiSuggestion[] => {
    const needle = query.toLowerCase();

    if (needle === "" || limit <= 0) {
        return [];
    }

    const results: EmojiSuggestion[] = [];
    const listed = new Set<string>();

    const add = (entry: IndexedShortcode, matchIndex: number): void => {
        listed.add(entry.emoji);
        results.push({ emoji: entry.emoji, matchIndex, matchLength: needle.length, shortcode: entry.shortcode });
    };

    for (const entry of index) {
        if (results.length >= limit) {
            break;
        }

        if (entry.lower.startsWith(needle) && !listed.has(entry.emoji)) {
            add(entry, 0);
        }
    }

    for (const entry of index) {
        if (results.length >= limit) {
            break;
        }

        const matchIndex = entry.lower.indexOf(needle);

        if (matchIndex > 0 && !listed.has(entry.emoji)) {
            add(entry, matchIndex);
        }
    }

    return results;
};
