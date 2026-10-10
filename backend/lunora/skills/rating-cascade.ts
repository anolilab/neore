/**
 * Keeping `skillRatings` and the `skillStats` aggregate honest when a skill or a
 * rater goes away.
 *
 * Ratings belong to the RATER (`userId`), not the skill's owner, so deleting a
 * skill used to leave every other user's rating row pointing at nothing — and
 * erasing a rater left their score folded into the average of skills they no
 * longer exist to have rated. `skillRatings` is `.global()` D1, so each delete
 * commits on its own: callers delete these children BEFORE the parent they are
 * reached through, the same crash-order rule as `gdpr/steps/deletion-steps.ts`.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

import { summarizeRatings } from "./marketplace-logic";

type Database = MutationCtx["db"];

/** Delete every rating of `skillId`, whoever wrote it. Idempotent. */
export const deleteSkillRatings = async (db: Database, skillId: Id<"skills">): Promise<number> => {
    const { page } = await db.skillRatings.findMany({ where: { skillId } });

    await Promise.all(page.map((row) => db.delete(row._id)));

    return page.length;
};

/**
 * Re-derive `skillStats.{rating, ratingCount}` for each skill, without
 * `excludeUserId`'s ratings. Call it BEFORE deleting that user's rating rows; it
 * already ignores them, so a crash on either side of the delete converges.
 */
export const recomputeSkillRatings = async (db: Database, skillIds: Iterable<Id<"skills">>, excludeUserId: string): Promise<void> => {
    const unique = new Set(skillIds);

    for (const skillId of unique) {
        const [ratings, stats] = await Promise.all([db.skillRatings.findMany({ where: { skillId } }), db.skillStats.findMany({ where: { skillId } })]);
        const summary = summarizeRatings(ratings.page, excludeUserId);

        await Promise.all(stats.page.map((row) => db.patch(row._id, summary)));
    }
};
