/**
 * The OWNER's own state on a thread: whether they have seen the latest reply, and
 * whether the thread is snoozed out of their active list. The row is shared with
 * grantees, so every procedure here is owner-only and none touches `updatedAt`
 * (the lists sort by it). Writes go through `agent/table-writes.ts`.
 */
import { v } from "lunorash/server";

import { markThreadViewedAt, patchThread, setThreadSnooze } from "../agent/table-writes";
import { requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
import { internalMutation } from "../_generated/server";
import { authMutation, rateLimit } from "../lib/crpc";
import { throwBadRequest } from "../lib/error-helpers";
import { appendDocumentHistory } from "../lib/document-history";
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

        context.log.event("chat.snooze_thread", { snoozedForMs: until - context.now });

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

        context.log.event("chat.unsnooze_thread", { wasSnoozed: thread.snoozedUntil !== undefined });

        return null;
    });

/**
 * Carries a mode onto a thread the owner just made from one of their own (a branch). Internal: the caller has checked the owner of
 * the source thread, so this writes without a second check. A thread made from a host thread has no mode and is not sent here.
 */
export const copyThreadPermissionMode = internalMutation
    .input({
        mode: v.union(v.literal("supervised"), v.literal("auto-edit"), v.literal("auto"), v.literal("full")),
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
        mode: v.union(v.literal("supervised"), v.literal("auto-edit"), v.literal("auto"), v.literal("full")),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args: { mode, threadId }, ctx: context }) => {
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        if (thread.runner === "host") {
            return throwBadRequest("A host thread has no permission mode");
        }

        if (thread.permissionMode !== mode) {
            await patchThread(context.db, thread._id, { permissionMode: mode });
            // Access changes are audited: the mode decides whether the thread's tools ask, so the owner'"'"'s history records it.
            await appendDocumentHistory(context.db, context.now, {
                attribution: { action: "update", source: "manual" },
                doc: { ...thread, permissionMode: mode },
                documentId: thread._id,
                isDeleted: false,
                oldDoc: thread,
                organizationId: thread.organizationId ?? undefined,
                tableName: "threads",
                userId: context.user.userId,
            });
        }

        return null;
    });
