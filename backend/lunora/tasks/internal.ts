/**
 * The task runner's state machine, server-side only.
 *
 * ## Orchestration
 *
 * On the scheduler, not `@lunora/workflow`: a cycle is at most 1 + N agent
 * rounds, each already a single action, and every hand-off is a mutation that
 * checks and advances state in one transaction. What a workflow would add —
 * resuming after a crash — the sweeper in {@link checkDueTasks} covers by
 * failing a round that stopped reporting, which a human can then retry.
 *
 * ## Idempotency
 *
 * Queuing a task mints a random `activeCycle` token. {@link claimRound} only
 * claims a round of the CURRENT cycle that has no `taskRuns` row yet, and
 * {@link completeRound} only finishes a run still `running` whose cycle is still
 * the task's. So a retried action, a duplicate schedule or a round finishing
 * after the user cancelled all resolve to a no-op rather than a second run or a
 * clobbered status. Cancelling is just clearing the token.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { enqueueJob } from "../lib/job-queue";
import { notifyQuietly } from "../notifications/notify";
import { patchById, withoutUndefined } from "../lib/patch";
import type { SkillContext } from "../skills/executor";
import { prepareSkillInvocation } from "../skills/executor";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { canReadSkill } from "../skills/access";
import { vSkillConfig } from "../skills/validators";
import { chargeRound, DAILY_LIMIT_MESSAGE, loadTaskAccount, taskAccessProblem } from "./account";
import type { TaskStatus } from "./logic";
import {
    canTransition,
    decideAfterVerdict,
    FINAL_ANSWER_MAX,
    findUnblockedDependents,
    initialRunStatus,
    isTaskModelAllowed,
    MAX_RECURRENCES_PER_USER_PER_SWEEP,
    MAX_TASKS_PER_USER,
    nextRecurrenceAt,
    pickFairRecurrences,
    shouldRecurNow,
} from "./logic";
import { vTaskRunOrigin, vVerdict } from "./validators";
import { vCodingAgentAssignment } from "../coding-agents/validators";

export type TaskRunOrigin = "dependency" | "manual" | "repair" | "retry" | "schedule";

/** Rows per sweep, per kind. */
const SWEEP_BATCH = 25;

/** Due recurrences read per sweep, so {@link pickFairRecurrences} can reach past one user's backlog. */
const SWEEP_SCAN = 200;

const UNVERIFIED_MESSAGE = "Automatic verification could not run, so this result needs your review.";

/** A queued round whose action never started. */
const STALE_QUEUED_MS = 15 * 60_000;

/** A running round that stopped reporting — longer than any 25-step Deep Work run. */
const STALE_RUNNING_MS = 60 * 60_000;

const RESULT_SUMMARY_MAX = 600;

/** Every task the user owns, bounded by the per-user ceiling. */
export const loadUserTasks = async (ctx: QueryCtx, userId: string): Promise<Doc<"tasks">[]> =>
    await ctx.db
        .query("tasks")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
        .take(MAX_TASKS_PER_USER);

export const statusMap = (tasks: ReadonlyArray<Doc<"tasks">>): Map<string, TaskStatus> => new Map(tasks.map((task) => [task._id as string, task.status]));

/** Mints a new cycle and schedules its first round. The caller has checked the transition. */
export const queueCycle = async (ctx: MutationCtx, task: Doc<"tasks">, origin: TaskRunOrigin, now: number): Promise<void> => {
    const cycle = crypto.randomUUID();

    await patchById(ctx.db, task._id, { activeCycle: cycle, lastError: undefined, status: "queued", updatedAt: now });
    // Jobs queue, not the scheduler (`lib/job-queue.ts`); a redelivery is refused by `claimRound`.
    await enqueueJob(internal.tasks.execute.runTaskRound, { cycle, origin, round: 0, taskId: task._id });
};

/**
 * Asks `task` to run: queued when its dependencies are done, `blocked` until
 * they are otherwise. Returns the status it landed in, or `undefined` when the
 * task is not in a state that may start.
 */
export const startTask = async (
    ctx: MutationCtx,
    task: Doc<"tasks">,
    origin: TaskRunOrigin,
    statusById: ReadonlyMap<string, TaskStatus>,
    now: number,
): Promise<"blocked" | "queued" | undefined> => {
    const target = initialRunStatus(task.dependsOn, statusById);

    if (!canTransition(task.status, target)) {
        return undefined;
    }

    if (target === "blocked") {
        await patchById(ctx.db, task._id, { activeCycle: undefined, status: "blocked", updatedAt: now });

        return "blocked";
    }

    await queueCycle(ctx, task, origin, now);

    return "queued";
};

/** After `completed` is done: queue every blocked dependent it was the last thing holding back. */
export const promoteDependents = async (ctx: MutationCtx, completed: Doc<"tasks">, now: number): Promise<void> => {
    const tasks = await loadUserTasks(ctx, completed.userId);
    const statusById = statusMap(tasks);

    statusById.set(completed._id as string, "done");

    const unblocked = new Set(findUnblockedDependents(completed._id as string, tasks, statusById));

    for (const task of tasks) {
        if (unblocked.has(task._id as string)) {
            await queueCycle(ctx, task, "dependency", now);
        }
    }
};

const summarise = (answer: string | undefined): string | undefined => {
    if (!answer) {
        return undefined;
    }

    const trimmed = answer.trim();

    return trimmed.length > RESULT_SUMMARY_MAX ? `${trimmed.slice(0, RESULT_SUMMARY_MAX - 1)}…` : trimmed;
};

// ─── Runner hand-offs ────────────────────────────────────────────────────────

/** Ends a cycle before its round runs, with `lastError` saying why. No `taskRuns` row: nothing ran. */
const refuseRound = async (ctx: MutationCtx, task: Doc<"tasks">, lastError: string): Promise<void> => {
    await patchById(ctx.db, task._id, { activeCycle: undefined, lastError, status: "failed", updatedAt: Date.now() });
};

const vClaim = v.union(
    v.null(),
    v.object({
        codingAgent: v.optional(vCodingAgentAssignment),
        goal: v.optional(v.object({ description: v.optional(v.string()), successCriteria: v.optional(v.string()), title: v.string() })),
        instructions: v.string(),
        model: v.optional(v.string()),
        organizationId: v.optional(v.string()),
        repair: v.optional(v.object({ reasons: v.array(v.string()), repairInstructions: v.optional(v.string()) })),
        reviewNote: v.optional(v.string()),
        runId: v.id("taskRuns"),
        skillId: v.optional(v.id("skills")),
        successCriteria: v.optional(v.string()),
        title: v.string(),
        userId: v.string(),
    }),
);

/**
 * Claims one round: inserts its `taskRuns` row and marks the task running.
 * `null` means "not yours to run" — stale cycle, wrong status, or already claimed
 * — or that the round was refused before it cost anything:
 *
 * - the account is being deleted: the cycle is dropped silently, since the
 *   deletion workflow is about to remove the task, and a run now would write a
 *   thread behind the step that erased the user's threads;
 * - the account is anonymous, the task's model is no longer allowed, or a daily
 *   limit is spent: the task fails with the reason.
 *
 * The daily limits are charged here, in the claim's transaction, so a retried
 * or duplicate action cannot charge twice and a refused round charges nothing.
 */
export const claimRound = internalMutation
    .input({ cycle: v.string(), origin: vTaskRunOrigin, round: v.number(), taskId: v.id("tasks") })
    .output(vClaim)
    .mutation(async ({ args: { cycle, origin, round, taskId }, ctx }) => {
        const task = await ctx.db.get(taskId);

        if (!task || task.activeCycle !== cycle) {
            return null;
        }

        const expected: TaskStatus = round === 0 ? "queued" : "running";

        if (task.status !== expected) {
            return null;
        }

        const existing = await ctx.db
            .query("taskRuns")
            .withIndex("by_cycle_and_round", (q) => q.eq("cycle", cycle).eq("round", round))
            .first();

        if (existing) {
            return null;
        }

        if (await isAccountDeletionUnderway(ctx, task.userId)) {
            await patchById(ctx.db, task._id, { activeCycle: undefined, status: "todo", updatedAt: ctx.now });

            return null;
        }

        const account = await loadTaskAccount(ctx, task.userId);
        const problem = taskAccessProblem(account);

        if (problem || !account) {
            await refuseRound(ctx, task, problem ?? "Your account no longer exists.");

            return null;
        }

        if (task.model && !isTaskModelAllowed(task.model, (id) => MODEL_LOOKUP.get(id))) {
            await refuseRound(ctx, task, `The model '${task.model}' is no longer available for tasks. Pick another model and run the task again.`);

            return null;
        }

        if (!(await chargeRound(ctx, task.userId, account))) {
            await refuseRound(ctx, task, DAILY_LIMIT_MESSAGE);

            return null;
        }

        let repair: { reasons: string[]; repairInstructions?: string } | undefined;

        if (round > 0) {
            const previous = await ctx.db
                .query("taskRuns")
                .withIndex("by_cycle_and_round", (q) => q.eq("cycle", cycle).eq("round", round - 1))
                .first();

            if (previous?.verdict && !previous.verdict.pass) {
                repair = { reasons: previous.verdict.reasons, repairInstructions: previous.verdict.repairInstructions };
            }
        }

        const now = ctx.now;
        const runId = await ctx.db.insert("taskRuns", {
            cycle,
            origin: round > 0 ? "repair" : origin,
            round,
            startedAt: now,
            status: "running",
            taskId,
            userId: task.userId,
        });

        await ctx.db.patch(taskId, { attemptCount: task.attemptCount + 1, status: "running", updatedAt: now });

        const goal = task.goalId ? await ctx.db.get(task.goalId) : null;

        return {
            ...(task.codingAgent && { codingAgent: task.codingAgent }),
            goal:
                goal && goal.userId === task.userId
                    ? { description: goal.description ?? undefined, successCriteria: goal.successCriteria ?? undefined, title: goal.title }
                    : undefined,
            instructions: task.instructions,
            model: task.model ?? undefined,
            organizationId: task.organizationId ?? undefined,
            repair,
            reviewNote: task.reviewNote ?? undefined,
            runId: runId as Id<"taskRuns">,
            skillId: task.skillId ?? undefined,
            successCriteria: task.successCriteria ?? undefined,
            title: task.title,
            userId: task.userId,
        };
    });

/** Whether a round is still waiting for its outcome — a redelivered finisher checks this before paying for a verifier call. */
export const isRoundRunning = internalQuery
    .input({ runId: v.id("taskRuns") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        return run?.status === "running";
    });

/** What the verifier needs of a task, for a round completed after its claim (`finishCodingAgentRound`). */
export const getTaskForVerification = internalQuery
    .input({ taskId: v.id("tasks") })
    .output(v.union(v.object({ instructions: v.string(), successCriteria: v.optional(v.string()), title: v.string(), userId: v.string() }), v.null()))
    .query(async ({ args, ctx }) => {
        const task = await ctx.db.get(args.taskId);

        if (!task) {
            return null;
        }

        return {
            instructions: task.instructions,
            ...(task.successCriteria !== undefined && { successCriteria: task.successCriteria }),
            title: task.title,
            userId: task.userId,
        };
    });

/**
 * How a claimed round ended:
 *
 * - `error`: the agent run failed, so there is no answer;
 * - `verified`: the verifier judged the answer;
 * - `unverified`: there is an answer but the verifier could not run. No verdict
 *   is invented — the run records why, and a human decides rather than repair
 *   rounds being spent on a verifier that is down.
 */
const vRoundOutcome = v.union(
    v.object({ error: v.string(), kind: v.literal("error") }),
    v.object({ finalAnswer: v.string(), kind: v.literal("verified"), verdict: vVerdict }),
    v.object({ finalAnswer: v.string(), kind: v.literal("unverified") }),
);

/**
 * Finishes a claimed round and decides what happens next: done (and unblock
 * dependents), another repair round, a human review, or failed on an error.
 */
/**
 * The inbox entry for a round that ended: done (success), failed, or waiting
 * for review (a failure the user decides on). Deduped per run, since a queue
 * redelivery can reach `completeRound` twice — its status check stops the
 * second write, and the key stops a second notification regardless.
 */
const notifyTaskRound = async (
    ctx: MutationCtx,
    task: Doc<"tasks">,
    run: Doc<"taskRuns">,
    outcome: "failure" | "success",
    detail: string | undefined,
): Promise<void> =>
    await notifyQuietly(ctx, {
        dedupeKey: `task:${run._id}`,
        link: "/tasks",
        outcome,
        title: task.title,
        type: "task",
        userId: task.userId,
        ...(detail && { body: detail }),
    });

export const completeRound = internalMutation
    .input({
        outcome: vRoundOutcome,
        runId: v.id("taskRuns"),
        threadId: v.optional(v.string()),
    })
    .output(v.union(v.null(), v.union(v.literal("done"), v.literal("repair"), v.literal("needs_review"), v.literal("failed"), v.literal("cancelled"))))
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.status !== "running") {
            return null;
        }

        const { outcome } = args;
        const now = ctx.now;
        const finalAnswer = outcome.kind === "error" ? undefined : outcome.finalAnswer.slice(0, FINAL_ANSWER_MAX);
        // What every outcome records on the run row; absent values stay absent.
        const runResult = withoutUndefined({ completedAt: now, finalAnswer, threadId: args.threadId });
        const task = await ctx.db.get(run.taskId);

        if (!task || task.activeCycle !== run.cycle) {
            await ctx.db.patch(run._id, { ...runResult, status: "cancelled" });

            return "cancelled";
        }

        const lastRunThreadId = args.threadId ?? task.lastRunThreadId;

        if (outcome.kind === "error") {
            const error = outcome.error.slice(0, 2000);

            await ctx.db.patch(run._id, { ...runResult, error, status: "error" });
            await patchById(ctx.db, task._id, { activeCycle: undefined, lastError: error, lastRunThreadId, status: "failed", updatedAt: now });
            await notifyTaskRound(ctx, task, run, "failure", error);

            return "failed";
        }

        let next: "done" | "needs_review" | "repair";

        if (outcome.kind === "unverified") {
            // The answer is kept; the run says it is the check that failed.
            await ctx.db.patch(run._id, { ...runResult, error: UNVERIFIED_MESSAGE, status: "error" });
            next = "needs_review";
        } else {
            const verdict = {
                pass: outcome.verdict.pass,
                reasons: outcome.verdict.reasons,
                ...(outcome.verdict.repairInstructions && { repairInstructions: outcome.verdict.repairInstructions }),
            };

            await ctx.db.patch(run._id, { ...runResult, status: verdict.pass ? "passed" : "failed", verdict });
            next = decideAfterVerdict(verdict, run.round, task.maxRepairRounds);
        }

        if (next === "repair") {
            await ctx.db.patch(task._id, withoutUndefined({ lastRunThreadId, updatedAt: now }));
            await enqueueJob(internal.tasks.execute.runTaskRound, {
                cycle: run.cycle,
                origin: "repair",
                round: run.round + 1,
                taskId: task._id,
            });

            return "repair";
        }

        if (next === "needs_review") {
            await patchById(ctx.db, task._id, {
                activeCycle: undefined,
                lastRunThreadId,
                resultSummary: summarise(finalAnswer),
                status: "needs_review",
                updatedAt: now,
            });
            await notifyTaskRound(ctx, task, run, "failure", summarise(finalAnswer));

            return "needs_review";
        }

        const done = { ...task, status: "done" as const };

        await patchById(ctx.db, task._id, {
            activeCycle: undefined,
            lastError: undefined,
            lastRunThreadId,
            resultSummary: summarise(finalAnswer),
            reviewNote: undefined,
            status: "done",
            updatedAt: now,
        });
        await promoteDependents(ctx, done, now);
        await notifyTaskRound(ctx, task, run, "success", summarise(finalAnswer));

        return "done";
    });

/**
 * Whether a round may still create a thread for `userId`. The runner asks right
 * before `createThread`: an account deletion can start while a round claimed
 * earlier is still building its tools.
 */
export const canRunForUser = internalQuery
    .input({ userId: v.string() })
    .output(v.boolean())
    .query(async ({ args, ctx }) => !(await isAccountDeletionUnderway(ctx, args.userId)));

export interface ResolvedTaskSkill {
    config?: SkillContext["config"];
    instructions: string;
    /** The usage page files the run under `/<slug>`, as a slash command. */
    slug: string;
}

/**
 * A task's assigned skill, resolved for a headless run under the same rules a
 * slash command uses: readable by the owner and enabled, with each variable's
 * default filled in (`prepareSkillInvocation`). Resolved by id, never by slug —
 * a slug can name a different skill (the user's own beats an installed one).
 *
 * `organizationId` is what the task stored from the creator's session. There is
 * no session here, so membership is re-checked against `member` directly: a
 * user who left the organization loses its shared skills on the next run, the
 * same as they would in chat.
 */
export const resolveTaskSkillForRun = async (
    ctx: QueryCtx,
    { organizationId, skillId, userId }: { organizationId?: string; skillId: Id<"skills">; userId: string },
): Promise<ResolvedTaskSkill | { error: string }> => {
    const membership = organizationId ? await getMemberByOrganizationAndUser(ctx, organizationId, userId) : null;
    const subject = { organizationId: membership ? organizationId : undefined, userId };
    const skill = await ctx.db.skills.findFirst({ where: { _id: skillId } });

    if (!skill || !canReadSkill(skill, subject)) {
        return { error: "The assigned skill no longer exists or is not available to you." };
    }

    try {
        const prepared = await prepareSkillInvocation(ctx, skill, userId);

        return { config: prepared.config, instructions: prepared.instructions, slug: skill.slug };
    } catch (error) {
        return { error: error instanceof Error ? error.message : "The assigned skill cannot run." };
    }
};

export const resolveTaskSkill = internalQuery
    .input({ organizationId: v.optional(v.string()), skillId: v.id("skills"), userId: v.string() })
    .output(
        v.union(
            v.object({ error: v.string() }),
            v.object({
                // `v.from(...)`: codegen cannot read a bare const reference and
                // types it `{}`, which erased every config field in `execute.ts`.
                config: v.optional(v.from(vSkillConfig)),
                instructions: v.string(),
                slug: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => await resolveTaskSkillForRun(ctx, args));

// ─── Periodic work ───────────────────────────────────────────────────────────

/**
 * Due recurrences and stale rounds. Rides on the trigger schedule's
 * every-minute tick (`triggers/schedule.ts:checkDueTriggers`) rather than a cron
 * of its own.
 */
export const checkDueTasks = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const now = ctx.now;

        const due = pickFairRecurrences(
            await ctx.db
                .query("tasks")
                .withIndex("by_recurring_and_nextRunAt", (q) => q.eq("recurring", true).lte("nextRunAt", now))
                .take(SWEEP_SCAN),
            MAX_RECURRENCES_PER_USER_PER_SWEEP,
            SWEEP_BATCH,
        );

        const statusesByUser = new Map<string, Map<string, TaskStatus>>();

        for (const task of due) {
            if (task.nextRunAt === undefined || !task.cronExpression) {
                continue;
            }

            // Advance first, whatever happens next, so a task that cannot start
            // now is not re-examined every minute.
            await ctx.db.patch(task._id, { nextRunAt: nextRecurrenceAt(task.cronExpression, now), updatedAt: now });

            if (!shouldRecurNow(task.status)) {
                continue;
            }

            let statusById = statusesByUser.get(task.userId);

            if (!statusById) {
                statusById = statusMap(await loadUserTasks(ctx, task.userId));
                statusesByUser.set(task.userId, statusById);
            }

            const landed = await startTask(ctx, task, "schedule", statusById, now);

            if (landed) {
                statusById.set(task._id as string, landed);
            }
        }

        const failStale = async (status: "queued" | "running", olderThan: number, message: string): Promise<void> => {
            const stale = await ctx.db
                .query("tasks")
                .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status).lt("updatedAt", olderThan))
                .take(SWEEP_BATCH);

            for (const task of stale) {
                const cycle = task.activeCycle;

                if (cycle) {
                    const runs = await ctx.db
                        .query("taskRuns")
                        .withIndex("by_cycle_and_round", (q) => q.eq("cycle", cycle))
                        .take(20);

                    for (const run of runs) {
                        if (run.status === "running") {
                            await ctx.db.patch(run._id, { completedAt: now, error: message, status: "error" });
                        }
                    }
                }

                await patchById(ctx.db, task._id, { activeCycle: undefined, lastError: message, status: "failed", updatedAt: now });
            }
        };

        await failStale("queued", now - STALE_QUEUED_MS, "The run never started. Try running the task again.");
        await failStale("running", now - STALE_RUNNING_MS, "The run stopped responding and was abandoned. Try running the task again.");

        return null;
    });
