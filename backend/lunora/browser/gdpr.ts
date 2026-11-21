/**
 * The browser module's erasure: for account deletion (called by `gdpr/steps/deletion-steps.ts`) and for a deleted
 * thread's ask rows (called by `agent/threads.ts`). Plain functions over the caller's `ctx`.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** How many of a deleted thread's ask rows one delete page removes. */
const HUMAN_CHECK_DELETE_BATCH = 100;

/**
 * Deletes one batch of the sites a deleted thread's runs asked the person to clear; `true` when none are left. The
 * thread delete (`agent/threads.ts`) runs it page by page until then.
 */
export const deleteHumanChecksOfThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<boolean> => {
    const rows = await ctx.db
        .query("browserHumanChecks")
        .withIndex("by_threadId_site_run", (q) => q.eq("threadId", threadId))
        .take(HUMAN_CHECK_DELETE_BATCH + 1);
    const batch = rows.slice(0, HUMAN_CHECK_DELETE_BATCH);

    await Promise.all(batch.map((row) => ctx.db.delete("browserHumanChecks", row._id)));

    return rows.length <= HUMAN_CHECK_DELETE_BATCH;
};

/** Browser sessions with their actions, the sites a run asked the user to clear, and the user's browser extensions. */
export const eraseBrowserDataForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    // Delete browser sessions and their actions
    const sessions = await ctx.db
        .query("browserSessions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();

    const allActions = await Promise.all(
        sessions.map((session) =>
            ctx.db
                .query("browserActions")
                .withIndex("by_sessionId_timestamp", (q) => q.eq("sessionId", session._id))
                .collect(),
        ),
    );

    // Delete browser extensions
    const extensions = await ctx.db
        .query("browserExtensions")
        .withIndex("by_userId_status", (q) => q.eq("userId", userId))
        .collect();

    const humanChecks = await ctx.db
        .query("browserHumanChecks")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();

    await Promise.all([
        ...humanChecks.map((check) => ctx.db.delete("browserHumanChecks", check._id)),
        ...allActions.flat().map((a) => ctx.db.delete("browserActions", a._id)),
        ...sessions.map((s) => ctx.db.delete("browserSessions", s._id)),
        ...extensions.map((entry) => ctx.db.delete("browserExtensions", entry._id)),
    ]);
};
