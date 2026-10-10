import { describe, expect, it } from "vitest";

import { formatRating, functionQueryPrefix } from "./marketplace";

describe(formatRating, () => {
    it("rounds to one decimal and drops a trailing zero", () => {
        expect(formatRating(4)).toBe("4");
        expect(formatRating(13 / 3)).toBe("4.3");
        expect(formatRating(4.96)).toBe("5");
    });
});

describe(functionQueryPrefix, () => {
    it("keeps only the function part of a Lunora query key", () => {
        expect(functionQueryPrefix(["lunora", "skills_marketplace:browseSkills", { limit: 24 }, null])).toStrictEqual([
            "lunora",
            "skills_marketplace:browseSkills",
        ]);
    });
});
