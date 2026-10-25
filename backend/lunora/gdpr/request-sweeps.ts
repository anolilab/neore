/**
 * GDPR request housekeeping, run by the cron tick (`crons.ts` PERIODIC_JOBS)
 * and the per-shard housekeeping sweep (`lib/shard-housekeeping.ts`): expired
 * exports are deleted, and requests open past the 30-day Article 12 deadline
 * are failed. Each writes an audit row. Moved here from `crons.ts` because this
 * module owns `gdprRequests` and `gdprAuditLog`; the job names (and so their
 * `cronRuns` slots) are unchanged.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { cronsLogger } from "../lib/logger";
import { patchRow } from "../lib/patch";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";

/** Expired exports handled per run; the next run (every tick slot) picks up the rest. */
const EXPIRED_EXPORT_BATCH_SIZE = 100;

/**
 * Rows one run reads while looking for {@link EXPIRED_EXPORT_BATCH_SIZE} to handle.
 * A row whose storage delete fails keeps its place at the front of `by_expires`, so
 * the run reads past it; this is how many such rows it can skip before giving up
 * until the next slot.
 */
const EXPIRED_EXPORT_READ_BUDGET = 1000;

export const cleanupExpiredExports = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        const { now } = context;
        // Each handled row leaves the `by_expires` index below. The sweep used to keep
        // `expiresAt` set, so every run re-selected every expired export and wrote
        // another audit row for each, forever. A row that could not be handled stays
        // in the index, so the read pages past it instead of re-taking the same front.
        let cursor: null | string = null;
        let handled = 0;
        let read = 0;

        while (handled < EXPIRED_EXPORT_BATCH_SIZE && read < EXPIRED_EXPORT_READ_BUDGET) {
            const page = await context.db
                .query("gdprRequests")
                .withIndex("by_expires", (q) => q.lt("expiresAt", now))
                .paginate({ cursor, numItems: EXPIRED_EXPORT_BATCH_SIZE });

            read += page.page.length;

            for (const request of page.page) {
                // The cap is per run, not per page: stop mid-page once it is reached.
                if (handled >= EXPIRED_EXPORT_BATCH_SIZE) {
                    break;
                }

                if (request.storageId) {
                    try {
                        await scheduleObjectDeletion(context, [request.storageId as string]);
                    } catch (error) {
                        // Keep the row as it is, so a later run retries the deletion. Clearing
                        // `storageId` here would orphan the stored file, and moving `expiresAt`
                        // would reopen the download of an expired export.
                        cronsLogger.error(`Failed to delete storage for request ${request._id}:`, error);

                        continue;
                    }
                }

                // `undefined` removes the field: `expiresAt` is what puts a row in the
                // index, so removing it is what makes this sweep terminal.
                await patchRow(context.db, request, {
                    downloadUrl: undefined,
                    errorMessage: "Export expired and has been deleted",
                    expiresAt: undefined,
                    status: "completed",
                    storageId: undefined,
                });

                await context.db.insert("gdprAuditLog", {
                    action: "export_expired",
                    details: JSON.stringify({ requestId: request._id }),
                    performedBy: "system",
                    timestamp: now,
                    userId: request.userId,
                });

                handled += 1;
            }

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }

        return null;
    });

export const handleGdprRequestTimeouts = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        const { now } = context;
        const timeoutMs = 30 * 24 * 60 * 60 * 1000;
        const timeoutThreshold = now - timeoutMs;

        // Query pending requests that are older than 30 days using the index
        const pendingTimedOut = await context.db
            .query("gdprRequests")
            .withIndex("by_status_and_requestedAt", (q) => q.eq("status", "pending").lt("requestedAt", timeoutThreshold))
            .collect();

        // Query processing requests that are older than 30 days using the index
        const processingTimedOut = await context.db
            .query("gdprRequests")
            .withIndex("by_status_and_requestedAt", (q) => q.eq("status", "processing").lt("requestedAt", timeoutThreshold))
            .collect();

        const timedOutRequests = [...pendingTimedOut, ...processingTimedOut];

        for (const request of timedOutRequests) {
            await context.db.patch(request._id, {
                errorMessage: "Request timed out after 30 days (GDPR Article 12 requirement)",
                status: "failed",
            });

            await context.db.insert("gdprAuditLog", {
                action: request.requestType === "export" ? "export_requested" : "deletion_requested",
                details: JSON.stringify({
                    action: "timeout",
                    requestedAt: request.requestedAt,
                    requestId: request._id,
                    timedOutAt: now,
                }),
                performedBy: "system",
                timestamp: now,
                userId: request.userId,
            });
        }

        return null;
    });
