/**
 * Suggested scheduled tasks: a list the person accepts from or dismisses.
 *
 * The feature is OPT-IN (`userSettings.scheduleIdeasEnabled`, absent = off) and nothing here creates a task by
 * itself: accepting goes through `insertTask`, the path `createTask` uses, and only for a pending row the caller
 * owns while the switch is on. Turning the switch off erases the rows (`eraseUserTaskSuggestions`).
 *
 * A row holds the proposed task in its own shape and the ids of the chats it came from — never message text.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { containsSecret } from "../lib/secret-redaction";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { isValidCronExpression } from "../triggers/schedule";
import { insertTask } from "./functions";
import { MAX_PENDING_SUGGESTIONS, MAX_SUGGESTION_SOURCES, TASK_INSTRUCTIONS_MAX, TASK_TITLE_MAX } from "./logic";

/** Rows removed per erase call; a full page queues the next. */
const ERASE_BATCH = 100;

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

        ctx.log.event("tasks.dismiss_suggestion", { suggestionId: row._id });

        return null;
    });

/**
 * Stores suggestions for one user. Server-only: the caller is the daily job. Writes nothing while the switch is off,
 * drops a proposal whose schedule is not a valid cron expression or whose text is empty, and keeps the pending list
 * within {@link MAX_PENDING_SUGGESTIONS}.
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

            const title = suggestion.title.trim().slice(0, TASK_TITLE_MAX);
            const instructions = suggestion.instructions.trim().slice(0, TASK_INSTRUCTIONS_MAX);
            const cronExpression = suggestion.cronExpression.trim();

            // The words come from the person's messages: a proposal that carries a secret is dropped, never stored.
            if (!title || !instructions || !isValidCronExpression(cronExpression) || containsSecret(title) || containsSecret(instructions)) {
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
 * was turned back on is newer than the cutoff and stays. A batch that deleted a full page queues the next one.
 */
export const eraseUserTaskSuggestions = internalMutation
    .input({ before: v.number(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { before, userId }, ctx }) => {
        const rows = await ctx.db
            .query("taskSuggestions")
            .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId))
            .take(ERASE_BATCH);
        const older = rows.filter((row) => row.createdAt <= before);

        for (const row of older) {
            await ctx.db.delete("taskSuggestions", row._id);
        }

        if (rows.length >= ERASE_BATCH && older.length > 0) {
            await runAfterOnShard(ctx.scheduler, 0, internal.tasks.suggestions.eraseUserTaskSuggestions, { before, userId }, userId);
        }

        return null;
    });
