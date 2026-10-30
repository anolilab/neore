import { describe, expect, it } from "vitest";

import type { FindableMessage } from "./match";
import { clampIndex, findMatches, messageText, occurrenceOffsets, stepIndex } from "./match";

const message = (id: string, role: string, ...texts: string[]): FindableMessage => {
    return {
        id,
        parts: texts.map((text) => {
            return { text, type: "text" };
        }),
        role,
    };
};

describe("occurrenceOffsets", () => {
    it("finds case-insensitive, non-overlapping occurrences", () => {
        expect(occurrenceOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
        expect(occurrenceOffsets("aaaa", "aa")).toEqual([0, 2]);
    });

    it("keeps offsets valid where lowercasing changes the length", () => {
        const text = "İİ cat";

        expect(occurrenceOffsets(text, "cat")).toEqual([3]);
        expect(text.slice(3, 6)).toBe("cat");
    });

    it("treats regex characters in the query literally", () => {
        expect(occurrenceOffsets("a.b a+b (x) [y] a|b", ".")).toEqual([1]);
        expect(occurrenceOffsets("a.b a+b (x) [y] a|b", "a+b")).toEqual([4]);
        expect(occurrenceOffsets("f(x) [y] $1 ^", "(x) [y] $1 ^")).toEqual([1]);
    });

    it("finds nothing for an empty or blank query", () => {
        expect(occurrenceOffsets("anything", "")).toEqual([]);
        expect(occurrenceOffsets("a b", " ".repeat(3))).toEqual([]);
    });
});

describe("messageText", () => {
    it("joins text parts and skips reasoning and tools", () => {
        const parts = [{ text: "one", type: "text" }, { text: "hidden", type: "reasoning" }, { type: "tool-search" }, { text: "two", type: "text" }];

        expect(messageText({ id: "m", parts, role: "assistant" })).toBe("one\ntwo");
    });
});

describe("findMatches", () => {
    it("lists matches in thread order with their occurrence inside the message", () => {
        const messages = [message("a", "user", "Cat and cat"), message("b", "assistant", "no hit"), message("c", "assistant", "a CAT")];

        expect(findMatches(messages, "cat")).toEqual([
            { messageId: "a", occurrence: 0 },
            { messageId: "a", occurrence: 1 },
            { messageId: "c", occurrence: 0 },
        ]);
    });

    it("searches only user and assistant messages", () => {
        expect(findMatches([message("s", "system", "cat"), message("t", "tool", "cat")], "cat")).toEqual([]);
    });

    it("finds nothing for an empty query", () => {
        expect(findMatches([message("a", "user", "cat")], "")).toEqual([]);
    });
});

describe("stepIndex", () => {
    it("wraps in both directions", () => {
        expect(stepIndex(2, 3, 1)).toBe(0);
        expect(stepIndex(0, 3, -1)).toBe(2);
        expect(stepIndex(1, 3, 1)).toBe(2);
    });

    it("stays at 0 without matches", () => {
        expect(stepIndex(0, 0, 1)).toBe(0);
    });
});

describe("clampIndex", () => {
    it("keeps the index inside the list", () => {
        expect(clampIndex(5, 3)).toBe(2);
        expect(clampIndex(1, 3)).toBe(1);
        expect(clampIndex(4, 0)).toBe(0);
    });
});
