/**
 * The Events log in account deletion (`gdpr/workflows/deletion-workflow.ts`, step "delete-user-mcp-events"). The log holds the
 * owner's run and approval events; it is erased in batches, and the workflow calls again while `hasMore` says so.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";

const BATCH = 200;

/**
 * Deletes up to `BATCH` of the user's events per call, then, once none are left, the user's sequence watermark. Idempotent on
 * retry.
 */
export const deleteUserMcpEvents = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        // One row past the batch says whether more follow: a batch that ends the log is not reported as more.
        const { page } = await ctx.db.mcpEvents.findMany({ limit: BATCH + 1, where: { userId } });

        for (const row of page.slice(0, BATCH)) {
            await ctx.db.delete("mcpEvents", row._id);
        }

        if (page.length > BATCH) {
            return { hasMore: true };
        }

        const { page: watermarks } = await ctx.db.mcpEventWatermarks.findMany({ where: { userId } });

        for (const row of watermarks) {
            await ctx.db.delete("mcpEventWatermarks", row._id);
        }

        return { hasMore: false };
    });
