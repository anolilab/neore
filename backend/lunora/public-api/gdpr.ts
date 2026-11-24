/**
 * The Events log in account deletion (`gdpr/workflows/deletion-workflow.ts`, step "delete-user-mcp-events") and in the account
 * export (`gdpr/workflows/export-workflow.ts`, step "collect-mcp-events"). The log holds the owner's run and approval events;
 * it is erased in batches, and the workflow calls again while `hasMore` says so.
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";

const BATCH = 200;

/**
 * The user's Events, every page to the last one, for the export. The data is the event's stored payload, as recorded: the
 * thread it concerns and its outcome or request, never a secret.
 */
export const collectMcpEventsForExport = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            events: v.array(
                v.object({ createdAt: v.number(), data: v.string(), eventId: v.string(), name: v.string(), seq: v.number(), timestamp: v.number() }),
            ),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        const rows: Doc<"mcpEvents">[] = [];
        let cursor: string | undefined;

        do {
            const result = await ctx.db.mcpEvents.findMany({ consistency: "primary", cursor, limit: BATCH, where: { userId } });

            rows.push(...result.page);
            cursor = result.isDone ? undefined : (result.continueCursor ?? undefined);
        } while (cursor !== undefined);

        return {
            events: rows.map((row) => {
                return { createdAt: row.createdAt, data: row.data, eventId: row.eventId, name: row.name, seq: row.seq, timestamp: row.timestamp };
            }),
        };
    });

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
