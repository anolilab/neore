/**
 * Suggested scheduled tasks: a list the person accepts from or dismisses.
 *
 * The feature is OPT-IN (`userSettings.scheduleIdeasEnabled`, absent = off) and nothing here creates a task by
 * itself: accepting goes through `insertTask`, the path `createTask` uses, and only for a pending row the caller
 * owns while the switch is on. Turning the switch off erases the rows (`eraseUserTaskSuggestions`).
 *
 * A row holds the proposed task in its own shape and the ids of the chats it came from — never message text.
 *
 * Rows are bounded. Pending ones stay within {@link MAX_PENDING_SUGGESTIONS}. A decided row is kept for the history
 * (and the export) only up to {@link MAX_DECIDED_SUGGESTIONS_PER_STATUS} per user and per status: deciding one more
 * deletes that user's rows of the same status decided longest ago (by `decidedAt`) above the cap, in the same transaction
 * (`trimDecidedSuggestions`), never the row just decided. `taskSuggestions` is not an audited table (`AUDIT_TABLES`), so a plain delete is right.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { containsSecret } from "../lib/secret-redaction";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { findNextCronTime, isValidCronExpression } from "../triggers/schedule";
import { insertTask, normalizeTaskText } from "./functions";
import {
    MAX_DECIDED_SUGGESTIONS_PER_STATUS,
    MAX_PENDING_SUGGESTIONS,
    MAX_SUGGESTION_SOURCES,
    TASK_INSTRUCTIONS_MAX,
    TASK_SCHEDULE_MAX,
    TASK_TITLE_MAX,
} from "./logic";

/** Rows removed per erase call; a full batch queues the next. */
const ERASE_BATCH = 100;

/** Rows over the decided cap removed by one decision. Each decision adds one row, so one is the usual number; the rest lets a lowered cap drain. */
const TRIM_EXTRA = 10;

const SUGGESTION_STATUSES = ["pending", "accepted", "dismissed"] as const;

/**
 * Keeps the rows of a decided status the person decided most recently, {@link MAX_DECIDED_SUGGESTIONS_PER_STATUS} of them, and
 * deletes the ones decided longest ago above it, at most {@link TRIM_EXTRA} per call. Ordered by decision time, not by when the
 * idea was suggested: an idea that waited a long while and is decided now is the newest decision and is kept. Reads the
 * `cap + TRIM_EXTRA` latest decisions only, never the whole history. Deletes one at a time, as every deletion in this module does.
 * `keepId`, the row this decision just wrote, is never deleted, whatever the order says.
 */
const trimDecidedSuggestions = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string,
    status: "accepted" | "dismissed",
    keepId: Id<"taskSuggestions">,
): Promise<void> => {
    const rows = await ctx.db
        .query("taskSuggestions")
        .withIndex("by_user_and_status_and_decidedAt", (q) => q.eq("userId", userId).eq("status", status))
        .order("desc")
        .take(MAX_DECIDED_SUGGESTIONS_PER_STATUS + TRIM_EXTRA);

    for (const row of rows.slice(MAX_DECIDED_SUGGESTIONS_PER_STATUS)) {
        if (row._id !== keepId) {
            await ctx.db.delete("taskSuggestions", row._id);
        }
    }
};

const vSuggestionView = v.object({
    _id: v.id("taskSuggestions"),
    createdAt: v.number(),
    cronExpression: v.string(),
    instructions: v.string(),
    sourceThreadIds: v.array(v.string()),
    title: v.string(),
});

/** Whether the person turned the feature on. OPT-IN: absent means off. */
export const readScheduleIdeasEnabled = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return settings?.scheduleIdeasEnabled === true;
};

/** The caller's pending suggestions, newest first, at most {@link MAX_PENDING_SUGGESTIONS}. Empty while the switch is off. */
export const listTaskSuggestions = authQuery
    .input({})
    .output(v.array(vSuggestionView))
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;

        if (!(await readScheduleIdeasEnabled(ctx, userId))) {
            return [];
        }

        const rows = await ctx.db
            .query("taskSuggestions")
            .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId).eq("status", "pending"))
            .order("desc")
            .take(MAX_PENDING_SUGGESTIONS);

        return rows.map((row) => {
            return {
                _id: row._id,
                createdAt: row.createdAt,
                cronExpression: row.cronExpression,
                instructions: row.instructions,
                sourceThreadIds: row.sourceThreadIds,
                title: row.title,
            };
        });
    });

/**
 * Turns a pending suggestion into a task. A row that is not the caller's answers NOT_FOUND (ids cannot be probed);
 * one already decided, or a switch that is off, is refused. The task and the status change are one transaction, so a
 * repeated or concurrent accept creates the task once.
 */
export const acceptTaskSuggestion = authMutation
    .use(rateLimit("tasks/create"))
    .input({ suggestionId: v.id("taskSuggestions") })
    .output(v.object({ taskId: v.id("tasks") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const row = await ctx.db.get("taskSuggestions", args.suggestionId);

        if (!row || row.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Suggestion not found");
        }

        if (!(await readScheduleIdeasEnabled(ctx, userId))) {
            throw new LunoraError("FORBIDDEN", "Schedule ideas are turned off");
        }

        if (row.status !== "pending") {
            throw new LunoraError("BAD_REQUEST", "This suggestion was already decided");
        }

        const { now } = ctx;
        const { recurring, taskId } = await insertTask(
            ctx,
            { now, organizationId: ctx.user.activeOrganization?.id, userId },
            { cronExpression: row.cronExpression, dependsOn: [], instructions: row.instructions, title: row.title },
        );

        await ctx.db.patch("taskSuggestions", row._id, { decidedAt: now, status: "accepted", taskId });
        await trimDecidedSuggestions(ctx, userId, "accepted", row._id);

        ctx.log.event("tasks.accept_suggestion", { recurring, suggestionId: row._id, taskId });

        return { taskId };
    });

/** Turns a pending suggestion down. Same ownership answer as accepting; no task is made. */
export const dismissTaskSuggestion = authMutation
    .use(rateLimit("tasks/update"))
    .input({ suggestionId: v.id("taskSuggestions") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get("taskSuggestions", args.suggestionId);

        if (!row || row.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Suggestion not found");
        }

        if (row.status !== "pending") {
            throw new LunoraError("BAD_REQUEST", "This suggestion was already decided");
        }

        await ctx.db.patch("taskSuggestions", row._id, { decidedAt: ctx.now, status: "dismissed" });
        await trimDecidedSuggestions(ctx, ctx.user.userId, "dismissed", row._id);

        ctx.log.event("tasks.dismiss_suggestion", { suggestionId: row._id });

        return null;
    });

/**
 * Stores suggestions for one user. Server-only: the caller is the daily job. Writes nothing while the switch is off,
 * drops a proposal whose schedule is not a valid cron expression, is longer than a task's schedule may be, or matches
 * no date (`0 0 30 2 *`: a task would fall back to running hourly), or whose text is empty, and keeps the pending
 * list within {@link MAX_PENDING_SUGGESTIONS}.
 */
export const insertTaskSuggestions = internalMutation
    .input({
        suggestions: v.array(
            v.object({
                cronExpression: v.string(),
                instructions: v.string(),
                sourceThreadIds: v.array(v.string()),
                title: v.string(),
            }),
        ),
        userId: v.string(),
    })
    .output(v.object({ inserted: v.number() }))
    .mutation(async ({ args: { suggestions, userId }, ctx }) => {
        if (!(await readScheduleIdeasEnabled(ctx, userId))) {
            return { inserted: 0 };
        }

        const pending = await ctx.db
            .query("taskSuggestions")
            .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId).eq("status", "pending"))
            .take(MAX_PENDING_SUGGESTIONS);
        let room = MAX_PENDING_SUGGESTIONS - pending.length;
        let inserted = 0;

        for (const suggestion of suggestions) {
            if (room <= 0) {
                break;
            }

            const fullTitle = normalizeTaskText(suggestion.title);
            const fullInstructions = normalizeTaskText(suggestion.instructions);

            // The words come from the person's messages: a proposal that carries a secret is dropped, never stored.
            // The check runs on the whole text, before the cut: a key that straddles the limit would leave only a part the detector misses.
            if (!fullTitle || !fullInstructions || containsSecret(fullTitle) || containsSecret(fullInstructions)) {
                continue;
            }

            const title = fullTitle.slice(0, TASK_TITLE_MAX);
            const instructions = fullInstructions.slice(0, TASK_INSTRUCTIONS_MAX);

            const cronExpression = normalizeTaskText(suggestion.cronExpression);

            // Accepting runs the task rules: a schedule they refuse, or one that never fires, is dropped here, not left pending.
            if (
                cronExpression.length > TASK_SCHEDULE_MAX ||
                !isValidCronExpression(cronExpression) ||
                findNextCronTime(cronExpression, ctx.now) === undefined
            ) {
                continue;
            }

            await ctx.db.insert("taskSuggestions", {
                createdAt: ctx.now,
                cronExpression,
                instructions,
                sourceThreadIds: [...new Set(suggestion.sourceThreadIds)].slice(0, MAX_SUGGESTION_SOURCES),
                status: "pending",
                title,
                userId,
            });
            room -= 1;
            inserted += 1;
        }

        return { inserted };
    });

/**
 * Erases the user's suggestions made before `before`, every status: queued when the switch is turned off
 * (`auth/functions.ts`, with the time of that save), on the user's own shard. A suggestion stored after the switch
 * was turned back on is newer than the cutoff and stays. The index sorts by status before time, so each status is
 * read with its own bound on `createdAt`: newer rows of one status never hide older rows of the next. A call that
 * filled its batch queues the next one.
 *
 * The cutoff is inclusive (`lte`) on purpose: a suggestion stored in the same millisecond as the opt-out was stored
 * before it, and a strict bound would leave it behind after the person switched the feature off. The opposite case
 * (a suggestion stored after a re-enable in that same millisecond) needs a save, a second save and a generation job
 * to all commit within one millisecond, and costs one idea.
 */
export const eraseUserTaskSuggestions = internalMutation
    .input({ before: v.number(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { before, userId }, ctx }) => {
        let erased = 0;

        for (const status of SUGGESTION_STATUSES) {
            if (erased >= ERASE_BATCH) {
                break;
            }

            const rows = await ctx.db
                .query("taskSuggestions")
                .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId).eq("status", status).lte("createdAt", before))
                .take(ERASE_BATCH - erased);

            for (const row of rows) {
                await ctx.db.delete("taskSuggestions", row._id);
            }

            erased += rows.length;
        }

        if (erased >= ERASE_BATCH) {
            await runAfterOnShard(ctx.scheduler, 0, internal.tasks.suggestions.eraseUserTaskSuggestions, { before, userId }, userId);
        }

        return null;
    });
