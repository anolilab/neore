/**
 * Goals, tasks and their run history in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-tasks") and
 * `gdpr/workflows/deletion-workflow.ts` — twice: "stop-user-tasks" at the start,
 * before any step a task round could write behind, and "delete-user-tasks" late,
 * for what a round already in flight left. Deletion follows
 * the residual steps' contract (`gdpr/steps/residual-deletion-steps.ts`): at most
 * `BATCH` rows per table per call, `{ hasMore }` back, idempotent on retry.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_GOALS_PER_USER, MAX_TASKS_PER_USER } from "./logic";

const BATCH = 100;

/** Runs per task in the export — the newest; older ones are history, not the task. */
const EXPORT_RUNS_PER_TASK = 50;

/** Suggestions per export step: the workflow persists each step's result, so a page stays small and a long history takes more steps. */
const EXPORT_SUGGESTIONS_PAGE = 100;

export const collectTasksForExport = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            goals: v.array(v.any()),
            tasks: v.array(v.any()),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        const [goals, tasks] = await Promise.all([
            ctx.db
                .query("goals")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
                .take(MAX_GOALS_PER_USER),
            ctx.db
                .query("tasks")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
                .take(MAX_TASKS_PER_USER),
        ]);

        const withRuns = await Promise.all(
            tasks.map(async ({ activeCycle: _cycle, ...task }) => {
                const runs = await ctx.db
                    .query("taskRuns")
                    .withIndex("by_task_and_startedAt", (q) => q.eq("taskId", task._id))
                    .order("desc")
                    .take(EXPORT_RUNS_PER_TASK);

                return {
                    ...task,
                    runs: runs.map(({ cycle: _runCycle, ...run }) => run),
                };
            }),
        );

        return { goals, tasks: withRuns };
    });

/**
 * One page of the user's suggestions, every status (decided ones stay until the switch is turned off, so a long
 * history is more than one page). `cursor` is `null` on the last page; the workflow walks them
 * (`collectAllTaskSuggestions`).
 */
export const collectTaskSuggestionsForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string(), v.null())), userId: v.string() })
    .output(v.object({ cursor: v.union(v.string(), v.null()), taskSuggestions: v.array(v.any()) }))
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("taskSuggestions")
            .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId))
            .paginate({ cursor: cursor ?? null, numItems: EXPORT_SUGGESTIONS_PAGE });

        return { cursor: page.isDone ? null : page.continueCursor, taskSuggestions: page.page };
    });

export const deleteUserTasks = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const [runs, tasks, goals, suggestions] = await Promise.all([
            ctx.db
                .query("taskRuns")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("tasks")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("goals")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("taskSuggestions")
                .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId))
                .take(BATCH),
        ]);

        await Promise.all([
            ...runs.map((row) => ctx.db.delete("taskRuns", row._id)),
            ...tasks.map((row) => ctx.db.delete("tasks", row._id)),
            ...goals.map((row) => ctx.db.delete("goals", row._id)),
            ...suggestions.map((row) => ctx.db.delete("taskSuggestions", row._id)),
        ]);

        return { hasMore: [runs, tasks, goals, suggestions].some((rows) => rows.length >= BATCH) };
    });
