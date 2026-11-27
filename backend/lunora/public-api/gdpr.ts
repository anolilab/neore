/**
 * The Events log and the Events webhook subscriptions in account deletion (`gdpr/workflows/deletion-workflow.ts`, step
 * "delete-user-mcp-events"), and the Events log in the account export (`gdpr/workflows/export-workflow.ts`, step
 * "collect-mcp-events"). The log holds the owner's run and approval events; the subscriptions hold their callback URLs and
 * encrypted secrets. Both are erased in batches, and the workflow calls again while `hasMore` says so.
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_LISTED_APPROVED_HOSTS, MAX_SUBSCRIPTIONS } from "./events-webhook";

const BATCH = 200;

/**
 * Rows the export reads per page. Whole rows are read, and a stored payload is at most `MAX_EVENT_PAYLOAD_BYTES` (`events-log.ts`,
 * 16 KiB), so a page holds at most 25 such rows at once, about 400 KiB.
 */
const EXPORT_PAGE = 25;

/**
 * The most events the export carries: the newest. A step result and the export file's dispatch body are each Lunora's 1 MiB, so a
 * longer history is cut, and the section says so (`truncated`), as a long browser history is cut in its export section.
 */
export const MAX_EXPORT_EVENTS = 500;

/** The bytes of event payloads the export carries, so the section stays well inside the 1 MiB step result and dispatch body. */
export const EXPORT_EVENT_BYTES = 512 * 1024;

/**
 * The rows one export may read, kept or skipped. An event left out for its size is still read, so a log of oversized events must not
 * keep the export step reading its whole history: past this the read stops, and the section says it was cut.
 */
export const EXPORT_SCAN_LIMIT = 1000;

/**
 * The bytes of event rows one export may read, kept or skipped, as the export serializes them. Stored payloads run to 16 KiB, so the row
 * limit alone lets one query read about 16 MiB; this matches the poll's read budget, so the section is cut before the transaction's limit.
 */
export const EXPORT_READ_BUDGET = 8 * 1024 * 1024;

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
        // Newest first, a page at a time. Each row is measured against the byte budget as it is read, so the rows held at once are
        // one page and the kept ones, never the whole history. A stored payload is at most `MAX_EVENT_PAYLOAD_BYTES`
        // (`events-log.ts`), and the byte budget (`EXPORT_EVENT_BYTES`) is what bounds the section.
        const encoder = new TextEncoder();
        const newest: Doc<"mcpEvents">[] = [];
        let bytes = 0;
        let read = 0;
        let truncated = false;
        let cursor: string | undefined;
        let more = true;
        let scanned = 0;

        while (more) {
            const result = await ctx.db.mcpEvents.findMany({
                consistency: "primary",
                cursor,
                limit: EXPORT_PAGE,
                orderBy: [{ seq: "desc" }],
                where: { userId },
            });

            for (const row of result.page) {
                // A row past the cap, or past the scan limit, exists, so the history was cut: the read stops there.
                if (newest.length === MAX_EXPORT_EVENTS || scanned === EXPORT_SCAN_LIMIT) {
                    truncated = true;
                    more = false;
                    break;
                }

                scanned += 1;

                // Measured as the export writes the event: JSON escapes quotes, backslashes and control characters, so their raw
                // bytes understate the size.
                const shaped = { createdAt: row.createdAt, data: row.data, eventId: row.eventId, name: row.name, seq: row.seq, timestamp: row.timestamp };
                const size = encoder.encode(JSON.stringify(shaped)).byteLength;

                // Every row read counts, kept or skipped. Past the read budget the scan stops, and the section says it was cut.
                if (read + size > EXPORT_READ_BUDGET) {
                    truncated = true;
                    more = false;
                    break;
                }

                read += size;

                // An event that does not fit is left out, and the older ones that do fit are still kept: the section never exceeds the
                // budget, and the gap it leaves is what `truncated` says.
                if (bytes + size > EXPORT_EVENT_BYTES) {
                    truncated = true;
                    continue;
                }

                bytes += size;
                newest.push(row);
            }

            cursor = result.isDone ? undefined : (result.continueCursor ?? undefined);
            more &&= cursor !== undefined;
        }

        return {
            events: newest.toReversed().map((row) => {
                return { createdAt: row.createdAt, data: row.data, eventId: row.eventId, name: row.name, seq: row.seq, timestamp: row.timestamp };
            }),
            truncated,
        };
    });

/**
 * Deletes up to `BATCH` of the user's events and of their subscriptions per call. Once both are empty, the user's sequence
 * watermark goes last, so the log is never left without the sequence it issues from. Idempotent on retry.
 */
export const deleteUserMcpEvents = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        // One row past the batch says whether more follow: a batch that ends the log is not reported as more.
        // From the primary: a replica that lags the deletion could report the log empty while rows remain.
        const { page } = await ctx.db.mcpEvents.findMany({ consistency: "primary", limit: BATCH + 1, where: { userId } });
        const { page: subscriptions } = await ctx.db.eventWebhookSubscriptions.findMany({
            consistency: "primary",
            limit: BATCH + 1,
            where: { userId },
        });

        for (const row of page.slice(0, BATCH)) {
            await ctx.db.delete("mcpEvents", row._id);
        }

        for (const row of subscriptions.slice(0, BATCH)) {
            await ctx.db.delete("eventWebhookSubscriptions", row._id);
        }

        if (page.length > BATCH || subscriptions.length > BATCH) {
            return { hasMore: true };
        }

        const { page: watermarks } = await ctx.db.mcpEventWatermarks.findMany({ consistency: "primary", where: { userId } });

        for (const row of watermarks) {
            await ctx.db.delete("mcpEventWatermarks", row._id);
        }

        return { hasMore: false };
    });

/**
 * The owner's Events webhook hosts and subscriptions, for the account export. Only what the owner can read back: the host names, and each
 * subscription's name, callback URL, arguments and times. The signing secret (ciphertext), the key hash and the API key id are left out.
 */
export const collectEventWebhooksForExport = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            hosts: v.array(v.object({ createdAt: v.number(), host: v.string() })),
            hostsTruncated: v.boolean(),
            subscriptions: v.array(v.object({ argumentsKey: v.string(), createdAt: v.number(), expiresAt: v.number(), name: v.string(), url: v.string() })),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        // One row past the ceiling says whether the owner has more; the export names that instead of dropping them without a word.
        const { page } = await ctx.db.eventWebhookHosts.findMany({ consistency: "primary", limit: MAX_LISTED_APPROVED_HOSTS + 1, where: { userId } });
        const hosts = page.slice(0, MAX_LISTED_APPROVED_HOSTS);
        const { page: subscriptions } = await ctx.db.eventWebhookSubscriptions.findMany({
            consistency: "primary",
            limit: MAX_SUBSCRIPTIONS,
            where: { userId },
        });

        return {
            hosts: hosts.map((row) => {
                return { createdAt: row.createdAt, host: row.host };
            }),
            hostsTruncated: page.length > MAX_LISTED_APPROVED_HOSTS,
            subscriptions: subscriptions.map((row) => {
                return { argumentsKey: row.argumentsKey, createdAt: row.createdAt, expiresAt: row.expiresAt, name: row.name, url: row.url };
            }),
        };
    });
