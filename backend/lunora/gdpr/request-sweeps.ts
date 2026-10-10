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
import { scheduleObjectDeletion } from "../lib/storage-cleanup";

export const cleanupExpiredExports = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx: context }) => {
        const now = context.now;
        const expiredRequests = await context.db
            .query("gdprRequests")
            .withIndex("by_expires", (q) => q.lt("expiresAt", now))
            .collect();

        for (const request of expiredRequests) {
            if (request.storageId) {
                try {
                    await scheduleObjectDeletion(context, [request.storageId as string]);
                } catch (error) {
                    cronsLogger.error(`Failed to delete storage for request ${request._id}:`, error);
                }
            }

            await context.db.patch(request._id, {
                errorMessage: "Export expired and has been deleted",
                status: "completed",
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
        const now = context.now;
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
