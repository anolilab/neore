/**
 * Deferred object deletion, for callers that run inside a transaction.
 *
 * Lunora types `ctx.storage` as `ReadOnlyStorage` in queries **and mutations** —
 * only actions get `delete` / `generateUploadUrl` / `store`. Some runtimes allow
 * `ctx.storage.delete` in a mutation; Lunora does not, and it is right not to: a
 * mutation runs in a Durable Object transaction that can roll back, and an R2
 * delete cannot. A mutation that deleted an object and then aborted would leave
 * the row intact and the bytes gone.
 *
 * So mutations schedule the delete instead of performing it. This is strictly
 * better than the direct-delete approach, not merely a workaround: the row deletion
 * commits transactionally, and the object cleanup runs only if it did. A rolled-
 * back mutation never schedules anything.
 *
 * The trade is that cleanup is no longer synchronous with the row write — an
 * object may briefly outlive its row. Nothing reads objects without their row, so
 * that window is invisible; a leak is only possible if the action itself fails,
 * which is why {@link deleteObjects} logs each failure with its key.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { storageLogger } from "./logger";

export const deleteObjects = internalAction.input({ keys: v.array(v.string()) }).action(async ({ args, ctx }) => {
    // Sequential, and each failure swallowed: one missing key must not strand
    // the rest of the batch. Missing is the common case — a retry of an
    // already-applied delete — and is not an error worth failing on.
    for (const key of args.keys) {
        try {
            await ctx.storage.delete(key);
        } catch (error) {
            storageLogger.warn(`Failed to delete storage object ${key}`, error);
        }
    }
});

/**
 * Queue objects for deletion after the current mutation commits.
 *
 * Resolves once the cleanup is SCHEDULED, not once the objects are gone. Empty
 * input is a no-op rather than an empty scheduled action.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export const scheduleObjectDeletion = async (context: Record<string, any>, keys: (null | string | undefined)[]): Promise<void> => {
    const present = keys.filter((key): key is string => Boolean(key));

    if (present.length === 0) {
        return;
    }

    await context.scheduler.runAfter(0, internal.lib.storage_cleanup.deleteObjects, { keys: present });
};
