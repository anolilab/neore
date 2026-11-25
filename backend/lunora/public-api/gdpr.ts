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
 * The most events the export carries: the newest. A step result and the export file's dispatch body are each Lunora's 1 MiB, so a
 * longer history is cut, and the section says so (`truncated`), as a long browser history is cut in its export section.
 */
export const MAX_EXPORT_EVENTS = 500;

/** The bytes of event payloads the export carries, so the section stays well inside the 1 MiB step result and dispatch body. */
export const EXPORT_EVENT_BYTES = 512 * 1024;

/**
 * The user's newest Events, up to {@link MAX_EXPORT_EVENTS}, oldest first, for the export. The data is the event's stored payload,
 * as recorded: the thread it concerns and its outcome or request, never a secret.
 */
export const collectMcpEventsForExport = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            events: v.array(
                v.object({ createdAt: v.number(), data: v.string(), eventId: v.string(), name: v.string(), seq: v.number(), timestamp: v.number() }),
            ),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        // Newest first, a page at a time, until one row past the cap is read: that row says the history was cut.
        const rows: Doc<"mcpEvents">[] = [];
        let cursor: string | undefined;

        do {
            const result = await ctx.db.mcpEvents.findMany({ consistency: "primary", cursor, limit: BATCH, orderBy: [{ seq: "desc" }], where: { userId } });

            rows.push(...result.page);
            cursor = result.isDone ? undefined : (result.continueCursor ?? undefined);
        } while (cursor !== undefined && rows.length <= MAX_EXPORT_EVENTS);

        // The newest that fit the byte budget: an event's payload can be large, and the cap on rows alone does not bound the bytes.
        const encoder = new TextEncoder();
        const newest: Doc<"mcpEvents">[] = [];
        let bytes = 0;

        for (const row of rows.slice(0, MAX_EXPORT_EVENTS)) {
            // Measured as the export writes the event: JSON escapes quotes, backslashes and control characters, so their raw
            // bytes understate the size.
            const shaped = { createdAt: row.createdAt, data: row.data, eventId: row.eventId, name: row.name, seq: row.seq, timestamp: row.timestamp };
            const size = encoder.encode(JSON.stringify(shaped)).byteLength;

            // An event that does not fit is left out, and the older ones that do fit are still kept: the section never exceeds the
            // budget, and the gap it leaves is what `truncated` says.
            if (bytes + size > EXPORT_EVENT_BYTES) {
                continue;
            }

            bytes += size;
            newest.push(row);
        }

        return {
            events: newest.toReversed().map((row) => {
                return { createdAt: row.createdAt, data: row.data, eventId: row.eventId, name: row.name, seq: row.seq, timestamp: row.timestamp };
            }),
            truncated: rows.length > newest.length,
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
