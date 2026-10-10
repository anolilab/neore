/**
 * Pure helpers for the skills marketplace, kept free of Lunora imports so they
 * can be unit-tested directly.
 */

const TRAILING_HYPHEN_RE = /-$/;

export const MIN_RATING = 1;
export const MAX_RATING = 5;

export const isValidRating = (rating: number): boolean => Number.isSafeInteger(rating) && rating >= MIN_RATING && rating <= MAX_RATING;

/**
 * Derive a skill's `{ rating, ratingCount }` from its rating rows, leaving out
 * `excludeUserId`'s (the user being erased). The ONE rating algorithm: rating a
 * skill (`rateSkill`) and erasing a rater (`recomputeSkillRatings`) both use it.
 *
 * Recomputed rather than folded into (or un-folded from) the stored average: the
 * erasure step can crash between fixing the stats and deleting the row, and an
 * inverse applied twice on the retry would subtract the same rating twice. A
 * recomputation that already ignores the departing user converges however often
 * it runs, before or after their rows are gone. The average is stored unrounded.
 */
export const summarizeRatings = (
    ratings: ReadonlyArray<{ rating: number; userId: string }>,
    excludeUserId?: string,
): { rating: number; ratingCount: number } => {
    const kept = ratings.filter((entry) => entry.userId !== excludeUserId);

    if (kept.length === 0) {
        return { rating: 0, ratingCount: 0 };
    }

    return { rating: kept.reduce((sum, entry) => sum + entry.rating, 0) / kept.length, ratingCount: kept.length };
};

/**
 * A slug for a fork that stays within `maxLength` and still matches the slug
 * format (no leading/trailing or doubled hyphens).
 */
export const forkSlug = (slug: string, now: number, maxLength: number): string => {
    const suffix = `-fork-${now.toString(36)}`;
    const base = slug.slice(0, Math.max(maxLength - suffix.length, 1)).replace(TRAILING_HYPHEN_RE, "");

    return `${base || "skill"}${suffix}`;
};
