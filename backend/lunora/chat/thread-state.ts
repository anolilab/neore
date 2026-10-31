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
import { isSnoozeInRange } from "./lib/thread-state-logic";

/** Marks the thread's latest reply as seen. A no-op unless a reply is newer than the last view. */
export const markThreadViewed = authMutation
    .use(rateLimit("chat/markViewed"))
    .input({ threadId: v.id("threads") })
    .output(v.object({ updated: v.boolean() }))
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        return { updated: await markThreadViewedAt(context.db, thread, context.now) };
    });

/** Hides the thread from the owner's active list until `until`. */
export const snoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        threadId: v.id("threads"),
        until: v.number().check((value) => Number.isFinite(value), { message: "Invalid snooze time" }),
    })
    .output(v.null())
    .mutation(async ({ args: { threadId, until }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        if (!isSnoozeInRange(until, context.now)) {
            return throwBadRequest("A snooze must end in the future, within a year");
        }

        await setThreadSnooze(context.db, thread, until);

        return null;
    });

/** Brings a snoozed thread back to the active list. */
export const unsnoozeThread = authMutation
    .use(rateLimit("chat/update"))
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        await setThreadSnooze(context.db, thread, undefined);

        return null;
    });
