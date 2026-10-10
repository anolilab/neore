/**
 * R2 Workspace Sync — V8 runtime functions
 *
 * Queries for the workspace sync feature. Kept separate from workspaceSync.ts
 * because that module uses "use node" for the AWS SDK and e2b imports, and
 * the runtime disallows queries/mutations in Node.js modules.
 */
import { v } from "lunorash/server";

import { internalQuery } from "../_generated/server";

export const getWorkspaceMetadata = internalQuery
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .query(async ({ args: { threadId, userId }, ctx }) => {
        const sessions = await ctx.db
            .query("sandboxSessions")
            .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId))
            .collect();

        const snapshotSession = sessions
            .filter((s) => s.userId === userId && s.cleanupFnId?.startsWith("workspace:"))
            .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)[0];

        if (!snapshotSession) {
            return null;
        }

        return {
            r2Key: snapshotSession.cleanupFnId!.slice("workspace:".length),
            sessionId: snapshotSession._id,
            snapshotAt: snapshotSession.lastActivityAt,
        };
    });
