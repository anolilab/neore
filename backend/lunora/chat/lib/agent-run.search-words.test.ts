/**
 * A prompt below {@link MIN_MEMORY_SEARCH_WORDS} skips the memory search. Counting
 * by whitespace used to count an unspaced Chinese or Japanese prompt as one word,
 * so it never reached the search at all.
 */
import { describe, expect, it } from "vitest";

import { countSearchWords } from "./agent-run";

describe("countSearchWords", () => {
    it("counts space-separated words", () => {
        expect(countSearchWords("thanks")).toBe(1);
        expect(countSearchWords("what is the weather today")).toBe(5);
    });

    it("counts an unspaced Chinese sentence as several words", () => {
        expect(countSearchWords("今天天气怎么样")).toBeGreaterThanOrEqual(3);
    });

    it("counts an unspaced Japanese sentence as several words", () => {
        expect(countSearchWords("今日はいい天気ですね")).toBeGreaterThanOrEqual(3);
    });

    it("does not count punctuation as a word", () => {
        expect(countSearchWords("ok!!!")).toBe(1);
        expect(countSearchWords("...")).toBe(0);
    });
});
