/**
 * The OWNER's own state on a thread: whether they have seen the latest reply, and
 * whether the thread is snoozed out of their active list. The row is shared with
 * grantees, so every procedure here is owner-only and none touches `updatedAt`
 * (the lists sort by it). Writes go through `agent/table-writes.ts`.
 */
import { LunoraError, v } from "lunorash/server";

import { markThreadViewedAt, patchThread, setThreadSnooze } from "../agent/table-writes";
import { requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
import { internalMutation } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { throwBadRequest } from "../lib/error-helpers";
import { COMPARISON_COLUMN_MODE_CODE } from "./lib/thread-permission-mode";
import { isSnoozeInRange, snoozeChoiceStamp } from "./lib/thread-state-logic";
import { isComparisonColumn, modeOfThread } from "./tool-permissions";

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

/**
 * Carries a mode onto a thread the owner just made from one of their own (a branch). Internal: the caller has checked the owner of
 * the source thread, so this writes without a second check. A thread made from a host thread has no mode and is not sent here.
 */
export const copyThreadPermissionMode = internalMutation
    .input({
        mode: v.union(v.literal("supervised"), v.literal("auto"), v.literal("full")),
        threadId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const thread = threadId ? await ctx.db.threads.findFirst({ where: { _id: threadId } }) : null;

        if (thread && thread.permissionMode !== args.mode) {
            await patchThread(ctx.db, thread._id, { permissionMode: args.mode });
        }

        return null;
    });

/**
 * Sets how much of a cloud thread's runs the owner leaves unasked. A host thread keeps its own approval rules, so it
 * has no mode to set. Takes effect on the next run; a run paused for approval applies the mode it finds when it resumes.
 */
export const setThreadPermissionMode = authMutation
    .use(rateLimit("chat/update"))
    .input({
        mode: v.union(v.literal("supervised"), v.literal("auto"), v.literal("full")),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args: { mode, threadId }, ctx: context }) => {
        // `full` lets the owner's tools run unasked: an admin acting as the owner must not widen what the owner's runs may do.
        if (context.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "The permission mode cannot be changed while impersonating");
        }

        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        if (thread.runner === "host") {
            return throwBadRequest("A host thread has no permission mode");
        }

        // A column's runs take its comparison's mode, so a mode saved here would never apply: it is changed on the comparison instead.
        if (await isComparisonColumn(context, thread._id)) {
            // Typed, so the client tells this refusal (nothing changed) from a save that failed.
            throw new LunoraError("BAD_REQUEST", "A comparison column takes its comparison's mode: change the mode on the comparison", {
                data: { code: COMPARISON_COLUMN_MODE_CODE },
            });
        }

        if (thread.permissionMode !== mode) {
            await patchThread(context.db, thread._id, { permissionMode: mode });
            // Who changed which thread's default tool permissions, and from what: kept in the request log for a later investigation.
            context.log.event("chat.thread_permission_mode_changed", { from: thread.permissionMode ?? "auto", threadId: thread._id, to: mode });
        }

        return null;
    });

/**
 * The mode the owner's runs on this thread use (`modeOfThread`). A comparison column whose parent still exists runs under that parent's
 * mode, whatever mode the column holds. Any other thread, a column whose parent is gone or trashed included, runs under its own
 * mode, Auto when it holds none. Owner-only; the composer shows it, so an opened comparison column does
 * not read Auto while its runs use the parent's mode.
 */
export const getEffectivePermissionMode = authQuery
    .input({ threadId: v.id("threads") })
    .output(v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"), v.null()))
    .query(async ({ args: { threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        return await modeOfThread(context, thread, context.user.userId);
    });
