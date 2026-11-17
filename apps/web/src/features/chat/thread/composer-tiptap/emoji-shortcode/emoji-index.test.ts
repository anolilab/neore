import { describe, expect, it, vi } from "vitest";

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

    it("finds the thumbs up for :+1 under its shortest shortcode", async () => {
        const [first] = searchEmojiShortcodes(await loadEmojiIndex(), "+1");

        expect(first).toMatchObject({ emoji: "👍", shortcode: "+1" });
    });

    it("finds the dog emoji by its shortcode", async () => {
        const [first] = searchEmojiShortcodes(await loadEmojiIndex(), "dog");

        expect(first).toMatchObject({ emoji: "🐕", shortcode: "dog", matchIndex: 0 });
    });

    // Last: it replaces the emoji module for the rest of the file, and restores it before the test ends.
    it("does not keep a failed load: the next call tries again", async () => {
        vi.resetModules();
        vi.doMock("@tiptap/extension-emoji", () => {
            return { gitHubEmojis: null };
        });

        const { loadEmojiIndex: loadBroken } = await import("./emoji-index");

        await expect(loadBroken()).rejects.toThrow(TypeError);

        vi.doUnmock("@tiptap/extension-emoji");

        const index = await loadBroken();

        expect(searchEmojiShortcodes(index, "dog")[0]).toMatchObject({ emoji: "🐕", shortcode: "dog" });
    });
});
