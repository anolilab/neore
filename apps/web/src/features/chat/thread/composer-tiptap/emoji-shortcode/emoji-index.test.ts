import { describe, expect, it } from "vitest";

import { getLoadedEmojiIndex, loadEmojiIndex } from "./emoji-index";
import { searchEmojiShortcodes } from "./search";

describe("loadEmojiIndex", () => {
    it("loads the index once and hands the same index to every caller", async () => {
        const first = await loadEmojiIndex();
        const second = await loadEmojiIndex();

        expect(second).toBe(first);
        expect(getLoadedEmojiIndex()).toBe(first);
    });

    it("ranks the real emoji data the way the reference list does for :spee", async () => {
        const results = searchEmojiShortcodes(await loadEmojiIndex(), "spee");

        expect(results.slice(0, 2).map((result) => result.shortcode)).toEqual(["speedboat", "speech_balloon"]);
        expect(results.length).toBeLessThanOrEqual(8);
    });

    it("finds the dog emoji by its shortcode", async () => {
        const [first] = searchEmojiShortcodes(await loadEmojiIndex(), "dog");

        expect(first).toMatchObject({ emoji: "🐕", shortcode: "dog", matchIndex: 0 });
    });
});
