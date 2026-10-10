/**
 * The skills module's erasure for account deletion (called by
 * `gdpr/steps/deletion-steps.ts` and `residual-deletion-steps.ts`). Plain
 * functions over the caller's `ctx`, so the writes are the owner's.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { gdprLogger } from "../lib/logger";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { deleteSkillRatings } from "./rating-cascade";

/**
 * The user's skills and everything they hang off, plus the skills' own
 * bookkeeping. Children first, parents only once every child delete has landed
 * (see the note inside).
 */
export const eraseSkillsForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    // Direct userId tables
    const [skills, userSkills, invocations] = await Promise.all([
        ctx.db.skills.findMany({ where: { userId } }).then((result) => result.page),
        ctx.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (q) => q.eq("userId", userId))
            .collect(),
        ctx.db
            .query("skillInvocations")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect(),
    ]);

    // Cascade: fetch child records for each skill
    const [allHistory, allStats, allFiles] = await Promise.all([
        Promise.all(
            skills.map((skill) =>
                ctx.db
                    .query("skillHistory")
                    .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id))
                    .collect(),
            ),
        ),
        Promise.all(skills.map((skill) => ctx.db.skillStats.findMany({ where: { skillId: skill._id } }).then((result) => result.page))),
        Promise.all(skills.map((skill) => ctx.db.skillFiles.findMany({ where: { skillId: skill._id } }).then((result) => result.page))),
    ]);

    // Other users' ratings of these skills: reachable only through `skillId`,
    // so they are children like the rest and go before the skills do.
    await Promise.all(skills.map((skill) => deleteSkillRatings(ctx.db, skill._id)));

    const flatFiles = allFiles.flat();

    // Delete stored blobs for skill files
    await Promise.all(
        flatFiles.map((f) =>
            scheduleObjectDeletion(ctx, [f.storageId as string]).catch((error: unknown) => {
                gdprLogger.error(`Failed to delete skill file blob ${f.storageId}:`, error);
            }),
        ),
    );

    // Children FIRST, parents only once every child delete has landed.
    //
    // `skills`, `skillStats` and `skillFiles` are `.global()` D1 tables, so each
    // delete commits on its own — a failed mutation does not roll them back.
    // These used to go out in one parallel batch: when a child delete failed
    // (the `Network connection lost` storms), the `skills` row was already
    // gone, and the retried step found no skill to reach its children through —
    // `skillStats` and `skillFiles` carry no `userId` — so both rows survived the
    // erasure for good. Ordered, a crash at any point leaves the parent behind
    // and the retry finds everything that is left.
    await Promise.all([
        ...allHistory.flat().map((h) => ctx.db.delete(h._id)),
        ...allStats.flat().map((s) => ctx.db.delete(s._id)),
        ...flatFiles.map((f) => ctx.db.delete(f._id)),
    ]);
    await Promise.all([
        ...skills.map((s) => ctx.db.delete(s._id)),
        ...userSkills.map((us) => ctx.db.delete(us._id)),
        ...invocations.map((inv) => ctx.db.delete(inv._id)),
    ]);
};

/**
 * The user's own ratings (`skillRatings`), given the rows the caller read. The
 * averages are recomputed BEFORE this runs (`recomputeSkillRatings`), so the
 * rows are only deleted here. Sequential: every delete fires the audit triggers.
 */
export const eraseSkillRatingRows = async (ctx: MutationCtx, rows: ReadonlyArray<{ _id: Id<"skillRatings"> }>): Promise<void> => {
    for (const row of rows) {
        await ctx.db.delete(row._id);
    }
};
