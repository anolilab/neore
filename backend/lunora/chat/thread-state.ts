/**
 * The OWNER's own state on a thread: whether they have seen the latest reply, and
 * whether the thread is snoozed out of their active list. The row is shared with
 * grantees, so every procedure here is owner-only and none touches `updatedAt`
 * (the lists sort by it). Writes go through `agent/table-writes.ts`.
 */
import { v } from "lunorash/server";

import { markThreadViewedAt, setThreadSnooze } from "../agent/table-writes";
import { requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
import { authMutation, rateLimit } from "../lib/crpc";
import { throwBadRequest } from "../lib/error-helpers";
import { isSnoozeInRange, snoozeChoiceStamp } from "./lib/thread-state-logic";

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
 * Hides the thread from the owner's active list until `until`. `chosenAt` orders the choice (`snoozeChoiceStamp`). A choice older
 * than the thread's newest one, or than a wake, is dropped before the range check (a stale queued write is not an error) and returns
 * `applied: false`.
 */
export const snoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        chosenAt: v.optional(v.number().check((value) => Number.isFinite(value), { message: "Invalid choice time" })),
        threadId: v.id("threads"),
        until: v.number().check((value) => Number.isFinite(value), { message: "Invalid snooze time" }),
    })
    .output(v.object({ applied: v.boolean() }))
    .mutation(async ({ args: { chosenAt, threadId, until }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        const stamp = snoozeChoiceStamp(chosenAt, context.now);

        if (thread.snoozeChosenAt !== undefined && stamp < thread.snoozeChosenAt) {
            context.log.event("chat.snooze_dropped", { reason: "stale" });

            return { applied: false };
        }

        if (!isSnoozeInRange(until, context.now)) {
            return throwBadRequest("A snooze must end in the future, within a year");
        }

        await setThreadSnooze(context.db, thread, until, stamp);

        context.log.event("chat.snooze_thread", { snoozedForMs: until - context.now });

        return { applied: true };
    });

/** Brings a snoozed thread back to the active list. A choice older than the thread's newest one (`snoozeChoiceStamp`) returns `applied: false`. */
export const unsnoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        chosenAt: v.optional(v.number().check((value) => Number.isFinite(value), { message: "Invalid choice time" })),
        threadId: v.id("threads"),
    })
    .output(v.object({ applied: v.boolean() }))
    .mutation(async ({ args: { chosenAt, threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        const applied = await setThreadSnooze(context.db, thread, undefined, snoozeChoiceStamp(chosenAt, context.now));

        context.log.event(applied ? "chat.unsnooze_thread" : "chat.unsnooze_dropped", { wasSnoozed: thread.snoozedUntil !== undefined });

        return { applied };
    });
