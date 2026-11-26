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
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { browserExportUserPrefix } from "../browser/export-pages";
import { withDependency } from "../lib/dependency";
import { MAX_LENGTH } from "../lib/validators";
import { TASK_SUGGESTIONS_EXPORT_PAGE, taskSuggestionsPageFileBytes } from "./export-pages";
import { MAX_GOALS_PER_USER, MAX_TASKS_PER_USER } from "./logic";

const BATCH = 100;

/** Runs per task in the export — the newest; older ones are history, not the task. */
const EXPORT_RUNS_PER_TASK = 50;

/** A stored page is filled with query pages until it holds this many bytes in the file, so a long history of short rows is few steps, not one per 8 rows. */
const SUGGESTIONS_PAGE_TARGET_BYTES = 512 * 1024;

/** The queries one stored page may take: a bound on the action's work whatever the rows weigh. */
const SUGGESTIONS_PAGE_MAX_QUERIES = 100;

/** The most a stored suggestion page can be: the target plus one more query page ({@link TASK_SUGGESTIONS_EXPORT_PAGE} rows of 20,000 characters, in the worst JSON escaping), with room. */
const SUGGESTIONS_PAGE_MAX_BYTES = 4 * 1024 * 1024;

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
 * history is more than one page), in descending status order: pending, then dismissed, then accepted, newest first
 * within each, so a history cut for its size loses accepted rows first and never the live ones. `cursor` is `null` on
 * the last page. A page is few rows ({@link TASK_SUGGESTIONS_EXPORT_PAGE}) because each can hold 20,000 characters of
 * instructions and a query result must stay under 1 MiB.
 */
export const collectTaskSuggestionsForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string(), v.null())), userId: v.string() })
    .output(v.object({ cursor: v.union(v.string(), v.null()), taskSuggestions: v.array(v.any()) }))
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("taskSuggestions")
            .withIndex("by_user_and_status_and_createdAt", (q) => q.eq("userId", userId))
            .order("desc")
            .paginate({ cursor: cursor ?? null, numItems: TASK_SUGGESTIONS_EXPORT_PAGE });

        return { cursor: page.isDone ? null : page.continueCursor, taskSuggestions: page.page };
    });

/**
 * One stored page of the suggestions: query pages ({@link collectTaskSuggestionsForExport}) read in this action and joined until
 * the page holds {@link SUGGESTIONS_PAGE_TARGET_BYTES}, the history ends or {@link SUGGESTIONS_PAGE_MAX_QUERIES} are spent, stored at
 * `key` (`export-pages.ts#taskSuggestionsExportPageKey`). Only its size in the file and its `next` cursor go back to the workflow,
 * so no step result or dispatch body carries the rows, and the walk is cut by bytes, never by a row count. As `agent/gdpr.ts#storeGrantRevisionsExportPage`: nothing is stored once the run
 * has stopped (`usage/gdpr.ts#exportRunStopped`), and a page whose write ends after it stopped is deleted again.
 */
export const storeTaskSuggestionsExportPage = internalAction
    .input({
        cursor: v.optional(v.string()),
        key: v.string(),
        runKey: v.string().max(MAX_LENGTH.key),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ bytes: v.number(), next: v.optional(v.string()) }))
    .action(async ({ args: { cursor, key, runKey, userId }, ctx }) => {
        // Only ever under the user's own export prefix: a key anywhere else would write another account's object.
        if (!key.startsWith(browserExportUserPrefix(userId))) {
            throw new LunoraError("FORBIDDEN", "A suggestion page belongs under the user's own export prefix");
        }

        const stopIfRunStopped = async (): Promise<void> => {
            if ((await ctx.runQuery(internal.usage.gdpr.exportRunStopped, { runKey, userId })) !== true) {
                return;
            }

            await withDependency("file storage", () => ctx.storage.delete(key));

            throw new LunoraError("CONFLICT", "The export has stopped: its request ended or the account's deletion is underway");
        };

        await stopIfRunStopped();

        const taskSuggestions: unknown[] = [];
        let bytes = 0;
        let next: string | undefined = cursor;

        for (let queries = 0; queries < SUGGESTIONS_PAGE_MAX_QUERIES && bytes < SUGGESTIONS_PAGE_TARGET_BYTES; queries += 1) {
            const page = (await ctx.runQuery(internal.tasks.gdpr.collectTaskSuggestionsForExport, { ...(next !== undefined && { cursor: next }), userId })) as {
                cursor: string | null;
                taskSuggestions: unknown[];
            };

            taskSuggestions.push(...page.taskSuggestions);
            bytes += taskSuggestionsPageFileBytes(page.taskSuggestions);
            next = page.cursor ?? undefined;

            if (next === undefined) {
                break;
            }
        }

        const blob = new Blob([JSON.stringify({ taskSuggestions })], { type: "application/json" });

        await withDependency("file storage", () =>
            ctx.storage.store(key, blob, { allowedContentTypes: ["application/json"], contentType: "application/json", maxSize: SUGGESTIONS_PAGE_MAX_BYTES }),
        );

        await stopIfRunStopped();

        return next === undefined ? { bytes } : { bytes, next };
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
