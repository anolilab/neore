import { describe, expect, it } from "vitest";

import { GLOB_MAX_CHARS, matchesGlob } from "./glob";

describe("matchesGlob", () => {
    it.each([
        ["build", "build", true],
        ["build", "builds", false],
        ["ci/*", "ci/unit", true],
        ["ci/*", "ci/", true],
        ["ci/*", "cl/unit", false],
        ["*", "", true],
        ["*", "anything at all", true],
        ["*test", "unit test", true],
        ["*test", "unit tests", false],
        ["test*", "tests", true],
        ["a*b*c", "a-b-c", true],
        ["a*b*c", "a-c-b", false],
        ["build (?)", "build (7)", true],
        ["build (?)", "build (10)", false],
        ["**", "x/y", true],
        ["", "", true],
        ["", "x", false],
        ["x", "", false],
        ["a.b", "axb", false],
        ["a+", "aaa", false],
        ["(a|b)", "a", false],
        ["[ab]", "a", false],
    ])("%j against %j is %s", (pattern, text, expected) => {
        expect(matchesGlob(pattern, text)).toBe(expected);
    });

    it("declines, rather than guessing, a pattern or name over the cap", () => {
        expect(matchesGlob("a".repeat(GLOB_MAX_CHARS + 1), "a")).toBeNull();
        expect(matchesGlob("a", "a".repeat(GLOB_MAX_CHARS + 1))).toBeNull();
        expect(matchesGlob("a".repeat(GLOB_MAX_CHARS), "a".repeat(GLOB_MAX_CHARS))).toBe(true);
    });

    describe("a hostile pattern", () => {
        // The shapes that make a backtracking regex take exponential time on a near miss.
        const HOSTILE = [
            [`${"*a".repeat(250)}b`, "a".repeat(GLOB_MAX_CHARS)],
            [`${"*".repeat(GLOB_MAX_CHARS - 1)}b`, "a".repeat(GLOB_MAX_CHARS)],
            [`${"?*".repeat(255)}x`, "a".repeat(GLOB_MAX_CHARS)],
            [`${"a*".repeat(255)}b`, "a".repeat(GLOB_MAX_CHARS)],
        ] as const;

        it.each(HOSTILE)("is answered, as a miss, within a fixed bound (%#)", (pattern, text) => {
            const started = performance.now();

            expect(matchesGlob(pattern, text)).toBe(false);
            expect(performance.now() - started).toBeLessThan(250);
        });
    });
});
