import { describe, expect, it } from "vitest";

import type { EmojiEntry } from "./search";
import { buildEmojiIndex, EMOJI_SUGGESTION_LIMIT, searchEmojiShortcodes } from "./search";

const fixture: EmojiEntry[] = [
    { emoji: "🚤", shortcodes: ["speedboat"] },
    { emoji: "💬", shortcodes: ["speech_balloon"] },
    { emoji: "🐕", shortcodes: ["dog"] },
    { emoji: "🌭", shortcodes: ["hotdog"] },
    { emoji: "🥬", shortcodes: ["cabbage"] },
    { emoji: "🧍", shortcodes: ["scar"] },
    { emoji: "👍", shortcodes: ["+1", "thumbsup", "yes"] },
    { emoji: "🎃", shortcodes: ["jack_o_lantern"] },
];

const shortcodesOf = (results: { shortcode: string }[]): string[] => results.map((result) => result.shortcode);

describe("searchEmojiShortcodes", () => {
    const index = buildEmojiIndex(fixture);

    it("ranks prefix matches before substring matches, even when the substring is shorter", () => {
        // "scar" contains "ca" but is shorter than "cabbage", which starts with it.
        expect(shortcodesOf(searchEmojiShortcodes(index, "ca"))).toEqual(["cabbage", "scar"]);
    });

    it("lists shorter prefix matches first within the prefix tier", () => {
        expect(shortcodesOf(searchEmojiShortcodes(index, "spee"))).toEqual(["speedboat", "speech_balloon"]);
    });

    it("lists an emoji once, under its shortest matching shortcode", () => {
        expect(searchEmojiShortcodes(index, "thumb")).toEqual([{ emoji: "👍", shortcode: "thumbsup", matchIndex: 0, matchLength: 5 }]);
        expect(searchEmojiShortcodes(buildEmojiIndex([{ emoji: "👍", shortcodes: ["thumbs_up", "thumbsup"] }]), "thumbs")).toEqual([
            { emoji: "👍", shortcode: "thumbsup", matchIndex: 0, matchLength: 6 },
        ]);
    });

    it("finds a shortcode by a substring and reports where the match starts", () => {
        expect(searchEmojiShortcodes(index, "dog")).toEqual([
            { emoji: "🐕", shortcode: "dog", matchIndex: 0, matchLength: 3 },
            { emoji: "🌭", shortcode: "hotdog", matchIndex: 3, matchLength: 3 },
        ]);
    });

    it("matches case-insensitively", () => {
        expect(shortcodesOf(searchEmojiShortcodes(index, "DOG"))).toEqual(["dog", "hotdog"]);
    });

    it("returns nothing for an empty query or no match", () => {
        expect(searchEmojiShortcodes(index, "")).toEqual([]);
        expect(searchEmojiShortcodes(index, "zzz")).toEqual([]);
    });

    it("keeps the list to the limit, taking the prefix matches first", () => {
        const many = buildEmojiIndex(
            Array.from({ length: 12 }, (_value, position) => {
                return { emoji: `e${position}`, shortcodes: [`ab${position}`] };
            }),
        );
        const results = searchEmojiShortcodes(many, "ab");

        expect(results).toHaveLength(EMOJI_SUGGESTION_LIMIT);
        expect(results.every((result) => result.matchIndex === 0)).toBe(true);
    });

    it("lists substring matches shortest first when no shortcode starts with the query", () => {
        expect(shortcodesOf(searchEmojiShortcodes(index, "o"))).toEqual(["dog", "hotdog", "speedboat", "speech_balloon", "jack_o_lantern"]);
    });
});
