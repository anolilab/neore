/**
 * Pre-warmed Sandbox Pool — V8 runtime functions
 *
 * Queries and mutations for the warm sandbox pool. Kept separate from pool.ts
 * because pool.ts uses "use node" for the e2b SDK, and the runtime disallows
 * queries/mutations in Node.js modules.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";

const WARM_SANDBOX_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const getWarmSandboxes = internalQuery.input({}).query(
    async ({ ctx }) =>
        await ctx.db
            .query("sandboxSessions")
            .withIndex("by_status", (q) => q.eq("status", "warm"))
            .collect(),
);

export const claimWarmSandbox = internalMutation
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .mutation(async ({ args: { threadId, userId }, ctx }) => {
        const warmSessions = await ctx.db
            .query("sandboxSessions")
            .withIndex("by_status", (q) => q.eq("status", "warm"))
            .take(1);

        const session = warmSessions[0];

        if (!session) {
            return null;
        }

        await ctx.db.patch(session._id, {
            lastActivityAt: ctx.now,
            status: "active",
            threadId,
            userId,
        });

        return {
            sandboxId: session.sandboxId,
            sessionId: session._id,
        };
    });

export const registerWarmSandbox = internalMutation
    .input({
        sandboxId: v.string(),
    })
    .mutation(async ({ args: { sandboxId }, ctx }) => {
        const now = ctx.now;

        await ctx.db.insert("sandboxSessions", {
            lastActivityAt: now,
            sandboxId,
            startedAt: now,
            status: "warm",
            timeoutMs: WARM_SANDBOX_TTL_MS,
            userId: "__pool__",
        });
    });
