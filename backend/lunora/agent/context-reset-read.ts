/**
 * The reader's side of `/clear`: which context reset, if any, the prompt's path holds. Internal, because the reply
 * context builder calls it from an action, which has no identity of its own.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { leafRowOf } from "./agent-switch";
import { getThreadRow } from "./branch-rows";
import { resetForTip } from "./context-reset";

export const getContextReset = internalQuery
    .input({
        promptMessageId: v.optional(v.id("messages")),
        threadId: v.id("threads"),
    })
    /** `branched`: whether the thread ever branched, so a reader without a named prompt knows if its rows are all on one path. */
    .output(v.union(v.object({ branched: v.boolean(), order: v.number() }), v.null()))
    .query(async ({ args, ctx }) => await contextResetOf(ctx, args.threadId, args.promptMessageId));

/**
 * The context reset (`/clear`) the tip of the thread's path (or of `promptMessageId`) holds, or `null`. Shared by the reader and by a
 * write that must check the reset in its own transaction (`agent/followup-suggestions.ts`).
 */
export const contextResetOf = async (
    ctx: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    promptMessageId?: Id<"messages">,
): Promise<{ branched: boolean; order: number } | null> => {
    const thread = await ctx.db.get("threads", threadId);

    // Unset = never cleared: nothing to cut, and no path is walked.
    if (!thread?.hasContextReset) {
        return null;
    }

    const tip = promptMessageId ? await getThreadRow(ctx as QueryCtx, threadId, promptMessageId) : await leafRowOf(ctx as QueryCtx, thread);

    if (!tip) {
        return null;
    }

    const reset = await resetForTip(ctx as QueryCtx, thread, tip);

    return reset ? { branched: thread.activeLeafMessageId !== undefined, order: reset.order } : null;
};
