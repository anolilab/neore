/**
 * The OWNER's own state on a thread: whether they have seen the latest reply, and
 * whether the thread is snoozed out of their active list. The row is shared with
 * grantees, so every procedure here is owner-only and none touches `updatedAt`
 * (the lists sort by it). Writes go through `agent/table-writes.ts`.
 */
import { v } from "lunorash/server";

import { isStaleSnoozeChoice, markThreadViewedAt, setThreadSnooze } from "../agent/table-writes";
import { requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
import { authMutation, rateLimit } from "../lib/crpc";
import { throwBadRequest } from "../lib/error-helpers";
import { isSnoozeInRange } from "./lib/thread-state-logic";

/** Marks the thread's latest reply as seen. A no-op unless a reply is newer than the last view. */
export const markThreadViewed = authMutation
    .use(rateLimit("chat/markViewed"))
    .input({ threadId: v.id("threads") })
    .output(v.object({ updated: v.boolean() }))
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        const updated = await markThreadViewedAt(context.db, thread, context.now);

        context.log.event("chat.mark_thread_viewed", { updated });

        return { updated };
    });

/**
 * The time the owner chose, by the client's clock, clamped to now: a device whose clock runs ahead cannot lock its later choices out.
 * A write queued offline carries the time it was made with, so it can arrive after a newer choice; `setThreadSnooze` drops it then.
 */
const chosenAtNow = (chosenAt: number | undefined, now: number): number | undefined => (chosenAt === undefined ? undefined : Math.min(chosenAt, now));

/** Hides the thread from the owner's active list until `until`. */
export const snoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        chosenAt: v.optional(v.number().check((value) => Number.isFinite(value), { message: "Invalid choice time" })),
        threadId: v.id("threads"),
        until: v.number().check((value) => Number.isFinite(value), { message: "Invalid snooze time" }),
    })
    .output(v.null())
    .mutation(async ({ args: { chosenAt, threadId, until }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        const choice = chosenAtNow(chosenAt, context.now);

        // A stale write is not a failure: the newer choice stands, so it is dropped before the range check can reject it.
        if (isStaleSnoozeChoice(thread, choice)) {
            return null;
        }

        if (!isSnoozeInRange(until, context.now)) {
            return throwBadRequest("A snooze must end in the future, within a year");
        }

        await setThreadSnooze(context.db, thread, until, choice);

        context.log.event("chat.snooze_thread", { snoozedForMs: until - context.now });

        return null;
    });

/** Brings a snoozed thread back to the active list. */
export const unsnoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        chosenAt: v.optional(v.number().check((value) => Number.isFinite(value), { message: "Invalid choice time" })),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args: { chosenAt, threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        const choice = chosenAtNow(chosenAt, context.now);

        await setThreadSnooze(context.db, thread, undefined, choice);

        context.log.event("chat.unsnooze_thread", { wasSnoozed: thread.snoozedUntil !== undefined });

        return null;
    });
