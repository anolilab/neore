import { describe, expect, it } from "vitest";

import { MAX_SLUG_LENGTH, SLUG_REGEX } from "./constants";
import { forkSlug, isValidRating, summarizeRatings } from "./marketplace-logic";

describe(isValidRating, () => {
    it.each([1, 3, 5])("accepts %d", (rating) => {
        expect(isValidRating(rating)).toBe(true);
    });

    it.each([0, 6, -1, 2.5, NaN, 1e9])("rejects %d", (rating) => {
        expect(isValidRating(rating)).toBe(false);
    });
});

describe(forkSlug, () => {
    it("appends a fork suffix", () => {
        expect(forkSlug("code-review", 1000, MAX_SLUG_LENGTH)).toBe(`code-review-fork-${(1000).toString(36)}`);
    });

    it("stays within the maximum length and slug format for long slugs", () => {
        const slug = forkSlug(`${"a".repeat(30)}-${"b".repeat(33)}`, Date.now(), MAX_SLUG_LENGTH);

        expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
        expect(SLUG_REGEX.test(slug)).toBe(true);
    });
});

describe(summarizeRatings, () => {
    const ratings = [
        { rating: 1, userId: "a" },
        { rating: 5, userId: "b" },
        { rating: 3, userId: "c" },
    ];

    it("averages every rating", () => {
        expect(summarizeRatings(ratings)).toStrictEqual({ rating: 3, ratingCount: 3 });
    });

    it("leaves out the departing user, the same however often it runs", () => {
        expect(summarizeRatings(ratings, "a")).toStrictEqual({ rating: 4, ratingCount: 2 });
        expect(
            summarizeRatings(
                ratings.filter((entry) => entry.userId !== "a"),
                "a",
            ),
        ).toStrictEqual({ rating: 4, ratingCount: 2 });
    });

    it("keeps the average unrounded", () => {
        expect(
            summarizeRatings([
                { rating: 4, userId: "a" },
                { rating: 4, userId: "b" },
                { rating: 5, userId: "c" },
            ]),
        ).toStrictEqual({ rating: 13 / 3, ratingCount: 3 });
    });

    it("resets to zero when nobody is left", () => {
        expect(summarizeRatings([{ rating: 2, userId: "a" }], "a")).toStrictEqual({ rating: 0, ratingCount: 0 });
    });
});
