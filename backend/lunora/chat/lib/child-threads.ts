import { LunoraError } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../../_generated/server";
import { publicThread } from "../../agent/threads";
import { isThreadLocked } from "../../lib/thread-lock";
import { threadGateOutcome, threadRowForList } from "./thread-gate";

const MAX_CHILD_THREADS = 200;

/**
 * The caller's own branches of a parent, read over `ctx.db`. A plain function, not a query, so the pane-state composite can call it
 * without nesting a query per child: Lunora bounds how deep queries may nest, and a parent with many children would exceed it.
 *
 * Throws `FORBIDDEN` for a parent another person owns; answers `[]` for one the caller does not own, and for a locked parent read
 * without its proof, whose branches are its content.
 */
export const readChildThreads = async (ctx: Pick<QueryContext, "db">, args: { parentThreadId: Id<"threads">; unlockProof?: string | null; userId: string }) => {
    const { parentThreadId, unlockProof, userId } = args;
    const parent = await ctx.db.get("threads", parentThreadId);

    if (parent?.userId && parent.userId !== userId) {
        throw new LunoraError("FORBIDDEN", "Access denied");
    }

    if (!parent || parent.userId !== userId) {
        return [];
    }

    if (isThreadLocked(parent) && (await threadGateOutcome(ctx, { level: "read", threadId: parentThreadId, unlockProof, userId })) !== "ok") {
        return [];
    }

    const relationships = await ctx.db
        .query("threadRelationships")
        .withIndex("by_parent_and_thread", (q) => q.eq("parentThreadId", parentThreadId))
        .take(MAX_CHILD_THREADS);
    const children = await Promise.all(relationships.map((relationship) => ctx.db.get("threads", relationship.threadId)));

    return relationships.flatMap((relationship, index) => {
        const child = children[index];

        // A relationship row is not a read grant: only the caller's own children.
        if (!child || child.userId !== userId) {
            return [];
        }

        return [
            {
                ...threadRowForList(publicThread(child)),
                branchPoint: relationship.branchPoint,
                branchType: relationship.branchType,
                createdAt: relationship.createdAt,
            },
        ];
    });
};
