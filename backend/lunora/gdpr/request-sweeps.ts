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

export const cleanupExpiredExports = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        const { now } = context;
        // Bounded, and each handled row leaves the `by_expires` index below. The
        // sweep used to keep `expiresAt` set, so every run re-selected every
        // expired export and wrote another audit row for each, forever.
        const expiredRequests = await context.db
            .query("gdprRequests")
            .withIndex("by_expires", (q) => q.lt("expiresAt", now))
            .take(EXPIRED_EXPORT_BATCH_SIZE);

        for (const request of expiredRequests) {
            if (request.storageId) {
                try {
                    await scheduleObjectDeletion(context, [request.storageId as string]);
                } catch (error) {
                    cronsLogger.error(`Failed to delete storage for request ${request._id}:`, error);
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
