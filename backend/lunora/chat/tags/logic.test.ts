import { describe, expect, it } from "vitest";

import {
    hasDuplicateTagName,
    nextTagOrder,
    normalizeTagName,
    THREAD_TAG_NAME_MAX_LENGTH,
    validateTagName,
    validateTagReorder,
    withTagAssignment,
} from "./logic";

describe("normalizeTagName", () => {
    it("trims and collapses internal whitespace", () => {
        expect(normalizeTagName("  work \t  stuff\n")).toBe("work stuff");
    });
});

describe("validateTagName", () => {
    it("rejects an empty name", () => {
        expect(validateTagName("")).toBeDefined();
    });

    it("accepts a name at the length limit and rejects one past it", () => {
        expect(validateTagName("a".repeat(THREAD_TAG_NAME_MAX_LENGTH))).toBeUndefined();
        expect(validateTagName("a".repeat(THREAD_TAG_NAME_MAX_LENGTH + 1))).toBeDefined();
    });
});

describe("hasDuplicateTagName", () => {
    const existing = [
        { _id: "t1", name: "Work" },
        { _id: "t2", name: "Personal" },
    ];

    it("matches case-insensitively", () => {
        expect(hasDuplicateTagName("work", existing)).toBe(true);
        expect(hasDuplicateTagName("Hobby", existing)).toBe(false);
    });

    it("ignores the tag being renamed", () => {
        expect(hasDuplicateTagName("WORK", existing, "t1")).toBe(false);
        expect(hasDuplicateTagName("personal", existing, "t1")).toBe(true);
    });
});

describe("nextTagOrder", () => {
    it("starts at 0 and goes one past the maximum, not the count", () => {
        expect(nextTagOrder([])).toBe(0);
        expect(nextTagOrder([{ order: 0 }, { order: 7 }, { order: 3 }])).toBe(8);
    });
});

describe("withTagAssignment", () => {
    it("adds a tag once and keeps existing order", () => {
        expect(withTagAssignment(["a"], "b", true)).toStrictEqual(["a", "b"]);
        expect(withTagAssignment(["a", "b"], "a", true)).toStrictEqual(["a", "b"]);
        expect(withTagAssignment(undefined, "a", true)).toStrictEqual(["a"]);
    });

    it("removes a tag, including duplicates left by a bad write", () => {
        expect(withTagAssignment(["a", "b", "a"], "a", false)).toStrictEqual(["b"]);
        expect(withTagAssignment(undefined, "a", false)).toStrictEqual([]);
    });

    it("does not mutate its input", () => {
        const input = ["a"];

        withTagAssignment(input, "b", true);

        expect(input).toStrictEqual(["a"]);
    });
});

describe("validateTagReorder", () => {
    it("accepts a permutation of every tag", () => {
        expect(validateTagReorder(["b", "a", "c"], ["a", "b", "c"])).toBeUndefined();
    });

    it("rejects duplicates, missing tags and foreign ids", () => {
        expect(validateTagReorder(["a", "a", "b"], ["a", "b", "c"])).toBeDefined();
        expect(validateTagReorder(["a", "b"], ["a", "b", "c"])).toBeDefined();
        expect(validateTagReorder(["a", "b", "x"], ["a", "b", "c"])).toBeDefined();
    });
});
