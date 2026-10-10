/**
 * The browser module's erasure for account deletion (called by
 * `gdpr/steps/deletion-steps.ts`). A plain function over the caller's `ctx`.
 */
import type { MutationCtx } from "../_generated/server";

/** Browser sessions with their actions, and the user's browser extensions. */
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

    await Promise.all([
        ...allActions.flat().map((a) => ctx.db.delete(a._id)),
        ...sessions.map((s) => ctx.db.delete(s._id)),
        ...extensions.map((entry) => ctx.db.delete(entry._id)),
    ]);
};
