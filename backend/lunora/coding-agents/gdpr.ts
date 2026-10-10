/**
 * Coding-agent runs in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-coding-agent-runs")
 * and `gdpr/workflows/deletion-workflow.ts` — "stop-user-coding-agents" early,
 * beside "kill-user-sandboxes" (cancel every active run, kill its sandbox while
 * the row still names it), and "delete-user-coding-agent-runs" late, for rows a
 * runner in flight wrote after the stop. Deletion follows the residual steps'
 * contract: at most `BATCH` rows per call, `{ hasMore }` back, idempotent.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { E2B_API_KEY } from "../env";
import { patchById } from "../lib/patch";
import { killE2BSandbox } from "./sandbox-provider";

const BATCH = 100;

/** Runs in the export — the newest. */
const EXPORT_RUNS = 500;

export const collectCodingAgentRunsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.any()))
    .query(async ({ args: { userId }, ctx }) => {
        const runs = await ctx.db
            .query("codingAgentRuns")
            .withIndex("by_user_and_createdAt", (q) => q.eq("userId", userId))
            .order("desc")
            .take(EXPORT_RUNS);

        // The sandbox id is an infrastructure handle, not the user's data.
        return runs.map(({ sandboxId: _sandboxId, ...run }) => run);
    });

/** Cancel every active run; returns the sandboxes still to kill. */
export const cancelUserCodingAgentRuns = internalMutation
    .input({ userId: v.string() })
    .output(v.array(v.string()))
    .mutation(async ({ args: { userId }, ctx }) => {
        const sandboxIds: string[] = [];
        const now = ctx.now;

        for (const status of ["queued", "running"] as const) {
            const runs = await ctx.db
                .query("codingAgentRuns")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", status))
                .take(BATCH);

            for (const run of runs) {
                if (run.sandboxId) {
                    sandboxIds.push(run.sandboxId);
                }

                await patchById(ctx.db, run._id, { completedAt: now, error: "Account deletion", status: "cancelled", updatedAt: now });
            }
        }

        return sandboxIds;
    });

export const stopUserCodingAgentRuns = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        const sandboxIds = await ctx.runMutation(internal.coding_agents.gdpr.cancelUserCodingAgentRuns, { userId });

        if (E2B_API_KEY) {
            await Promise.allSettled(sandboxIds.map(async (sandboxId) => await killE2BSandbox(E2B_API_KEY, sandboxId)));
        }

        return null;
    });

export const deleteUserCodingAgentRuns = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const runs = await ctx.db
            .query("codingAgentRuns")
            .withIndex("by_user_and_createdAt", (q) => q.eq("userId", userId))
            .take(BATCH);

        await Promise.all(runs.map(async (run) => await ctx.db.delete(run._id)));

        return { hasMore: runs.length >= BATCH };
    });
