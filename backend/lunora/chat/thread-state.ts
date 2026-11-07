/**
 * The OWNER's own state on a thread: whether they have seen the latest reply, and
 * whether the thread is snoozed out of their active list. The row is shared with
 * grantees, so every procedure here is owner-only and none touches `updatedAt`
 * (the lists sort by it). Writes go through `agent/table-writes.ts`.
 */
import { v } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
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
const chosenAtNow = (chosenAt: number, now: number): number => Math.min(chosenAt, now);

/** The event log a snooze choice writes to (the procedure's `ctx.log`). */
export interface SnoozeLog {
    event: (name: string, fields: Record<string, unknown>) => void;
}

/**
 * Applies one snooze choice and says what became of it. A choice the thread already has a newer one for is dropped: nothing is written,
 * it is logged as dropped with its reason, and the caller learns it did not apply. Anything applied is logged with `applied`'s fields.
 */
export const applySnoozeChoice = async (
    db: MutationCtx["db"],
    log: SnoozeLog,
    thread: Doc<"threads">,
    choice: { applied: Record<string, unknown>; chosenAt: number; kind: "snooze" | "unsnooze"; until: number | undefined },
): Promise<{ applied: boolean }> => {
    const applied = await setThreadSnooze(db, thread, choice.until, choice.chosenAt);

    if (applied) {
        log.event(choice.kind === "snooze" ? "chat.snooze_thread" : "chat.unsnooze_thread", choice.applied);

        return { applied: true };
    }

    log.event(choice.kind === "snooze" ? "chat.snooze_dropped" : "chat.unsnooze_dropped", { reason: "stale_ordering" });

    return { applied: false };
};

/**
 * Hides the thread from the owner's active list until `until`. The choice time is required: a request without it is refused with a
 * validation error, rather than applied or silently ignored, so an older client cannot erase a newer choice's ordering unnoticed.
 * Returns whether the snooze applied; a choice the thread already has a newer one for is dropped, and says so. A wake (a failed run, or one
 * that waits on the owner) also records its time as the ordering, so a choice made before the wake is dropped too.
 */
export const snoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        chosenAt: v.number().check((value) => Number.isFinite(value), { message: "Invalid choice time" }),
        threadId: v.id("threads"),
        until: v.number().check((value) => Number.isFinite(value), { message: "Invalid snooze time" }),
    })
    .output(v.object({ applied: v.boolean() }))
    .mutation(async ({ args: { chosenAt, threadId, until }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        const choice = chosenAtNow(chosenAt, context.now);

        // A stale write is not a failure: the newer choice stands, so it is dropped before the range check can reject it.
        if (!isStaleSnoozeChoice(thread, choice) && !isSnoozeInRange(until, context.now)) {
            return throwBadRequest("A snooze must end in the future, within a year");
        }

        return await applySnoozeChoice(context.db, context.log, thread, {
            applied: { snoozedForMs: until - context.now },
            chosenAt: choice,
            kind: "snooze",
            until,
        });
    });

/** Brings a snoozed thread back to the active list. Returns whether the unsnooze applied (a stale one does not). */
export const unsnoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        chosenAt: v.number().check((value) => Number.isFinite(value), { message: "Invalid choice time" }),
        threadId: v.id("threads"),
    })
    .output(v.object({ applied: v.boolean() }))
    .mutation(async ({ args: { chosenAt, threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        return await applySnoozeChoice(context.db, context.log, thread, {
            applied: { wasSnoozed: thread.snoozedUntil !== undefined },
            chosenAt: chosenAtNow(chosenAt, context.now),
            kind: "unsnooze",
            until: undefined,
        });
    });
