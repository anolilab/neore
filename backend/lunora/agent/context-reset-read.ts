/**
 * The reader's side of `/clear`: which context reset, if any, the prompt's path holds. Internal, because the reply
 * context builder calls it from an action, which has no identity of its own.
 */
import { v } from "lunorash/server";

import { internalQuery } from "../_generated/server";
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
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        // Unset = never cleared: nothing to cut, and no path is walked.
        if (!thread?.hasContextReset) {
            return null;
        }

        const tip = args.promptMessageId ? await getThreadRow(ctx, args.threadId, args.promptMessageId) : await leafRowOf(ctx, thread);

        if (!tip) {
            return null;
        }

        const reset = await resetForTip(ctx, thread, tip);

        return reset ? { branched: thread.activeLeafMessageId !== undefined, order: reset.order } : null;
    });
