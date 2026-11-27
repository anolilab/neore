/**
 * The emoji shortcode index, built once from the emoji data the editor already depends on.
 *
 * The data is ~64 KB gzipped, so it loads as its own chunk rather than with the composer. The composer starts the load
 * on mount, so the index is in memory before the first `:` is typed; nothing here calls the network beyond that chunk.
 */
import type { EmojiEntry, EmojiIndex } from "./search";
import { buildEmojiIndex } from "./search";

// One object, not module-level lets: the load assigns into it from inside a function.
const cache: { index?: EmojiIndex; loading?: Promise<EmojiIndex> } = {};

/** The index if it has loaded, else `undefined`. */
export const getLoadedEmojiIndex = (): EmojiIndex | undefined => cache.index;

/** Loads the index on first call and returns the same promise after that. A failed load is not kept: the next call tries again. */
export const loadEmojiIndex = (): Promise<EmojiIndex> => {
    cache.loading ??= import("@tiptap/extension-emoji")
        .then(({ gitHubEmojis }) => {
            const entries: EmojiEntry[] = [];

            for (const item of gitHubEmojis) {
                if (item.emoji !== undefined) {
                    entries.push({ emoji: item.emoji, shortcodes: item.shortcodes });
                }
            }

            const index = buildEmojiIndex(entries);

            cache.index = index;

            return index;
        })
        .catch((error: unknown) => {
            cache.loading = undefined;

            throw error;
        });

    return cache.loading;
};
