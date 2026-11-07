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
import type { TaskRunNoticeReason, TaskSkipReason, TaskStatus } from "./logic";
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
    latestSlotAtOrBefore,
    pickFairRecurrences,
    isPassingFallback,
    pickRunThread,
    recurrenceSkipReason,
} from "./logic";
import { vTaskRunNoticeReason, vTaskRunOrigin, vVerdict } from "./validators";
import { vCodingAgentAssignment } from "../coding-agents/validators";
import { writableProject } from "../projects/functions";

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

const STALE_AFTER_MS = { queued: STALE_QUEUED_MS, running: STALE_RUNNING_MS } as const;

const STALE_MESSAGE = {
    queued: "The run never started. Try running the task again.",
    running: "The run stopped responding and was abandoned. Try running the task again.",
} as const;

/** Why a task's round counts as dead (`updatedAt` is its last sign of life), or `undefined` when it does not. */
const staleRoundMessage = (task: Doc<"tasks">, now: number): string | undefined =>
    (task.status === "queued" || task.status === "running") && task.updatedAt < now - STALE_AFTER_MS[task.status] ? STALE_MESSAGE[task.status] : undefined;

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

    await patchById(ctx.db, "tasks", task._id, { activeCycle: cycle, lastError: undefined, status: "queued", updatedAt: now });
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
        await patchById(ctx.db, "tasks", task._id, { activeCycle: undefined, status: "blocked", updatedAt: now });

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

/**
 * What every path that fails a task writes: the error, and no `resultSummary`,
 * so an earlier run's result is never shown as the outcome of the one that
 * failed (`tasks/AGENTS.md`). The earlier answer stays on its own `taskRuns` row.
 */
const failedTaskPatch = (lastError: string, now: number) => {
    return {
        activeCycle: undefined,
        lastError,
        resultSummary: undefined,
        status: "failed" as const,
        updatedAt: now,
    };
};

/** Ends a cycle before its round runs, with `lastError` saying why. No `taskRuns` row: nothing ran. */
const refuseRound = async (ctx: MutationCtx, task: Doc<"tasks">, lastError: string): Promise<void> => {
    await patchById(ctx.db, "tasks", task._id, failedTaskPatch(lastError, Date.now()));
};

const vClaim = v.union(
    v.null(),
    v.object({
        codingAgent: v.optional(vCodingAgentAssignment),
        /** Writes the divider that marks the run's start; the first round of a fresh-context run only. */
        contextDivider: v.optional(v.boolean()),
        /** The thread this round appends to; unset starts a new thread (`pickRunThread`). */
        continueThreadId: v.optional(v.string()),
        /** No earlier turns sent to the model. */
        freshContext: v.optional(v.boolean()),
        goal: v.optional(v.object({ description: v.optional(v.string()), successCriteria: v.optional(v.string()), title: v.string() })),
        instructions: v.string(),
        /** The kept thread was only briefly out of reach (locked, busy): the task keeps it for its next run. */
        keepLastThread: v.optional(v.boolean()),
        model: v.optional(v.string()),
        organizationId: v.optional(v.string()),
        projectId: v.optional(v.id("projects")),
        reasoningEffort: v.optional(v.number()),
        repair: v.optional(v.object({ previousAnswer: v.optional(v.string()), reasons: v.array(v.string()), repairInstructions: v.optional(v.string()) })),
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
        const task = await ctx.db.get("tasks", taskId);

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
            await patchById(ctx.db, "tasks", task._id, { activeCycle: undefined, status: "todo", updatedAt: ctx.now });

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

        let repair: { previousAnswer?: string; reasons: string[]; repairInstructions?: string } | undefined;
        const previous =
            round > 0
                ? await ctx.db
                      .query("taskRuns")
                      .withIndex("by_cycle_and_round", (q) => q.eq("cycle", cycle).eq("round", round - 1))
                      .first()
                : null;

        if (previous?.verdict && !previous.verdict.pass) {
            repair = { reasons: previous.verdict.reasons, repairInstructions: previous.verdict.repairInstructions };
        }

        const { now } = ctx;
        const runId = await ctx.db.insert("taskRuns", {
            cycle,
            origin: round > 0 ? "repair" : origin,
            round,
            startedAt: now,
            status: "running",
            taskId,
            userId: task.userId,
        });

        await ctx.db.patch("tasks", taskId, { attemptCount: task.attemptCount + 1, status: "running", updatedAt: now });

        const goal = task.goalId ? await ctx.db.get("goals", task.goalId) : null;
        const { destination, notice, project } = await resolveRunPlace(ctx, task, round);

        // A repair round that starts without the thread's history (a new thread, or a fresh context) is given the
        // attempt it repairs; one that continues the thread with history has it in view already.
        if (repair && previous?.finalAnswer && (!destination.threadId || destination.freshContext)) {
            repair.previousAnswer = previous.finalAnswer;
        }

        const projectId = project?._id;

        // Only the first round of a cycle says where the run went: a repair round continues the thread round 0
        // ended in (`lastRunThreadId`), so clearing here would erase why round 0 fell back.
        if (round === 0 && (notice || task.lastRunNotice)) {
            await patchById(ctx.db, "tasks", task._id, { lastRunNotice: notice && { at: now, reason: notice } });
        }

        return {
            ...(task.codingAgent && { codingAgent: task.codingAgent }),
            ...(destination.threadId && { continueThreadId: destination.threadId }),
            ...(destination.divider && { contextDivider: true }),
            ...(destination.freshContext && { freshContext: true }),
            // A passing fallback this round, or a repair round continuing its cycle's fallback thread (not the task's
            // kept one): either way the task keeps its thread when the round completes.
            ...((isPassingFallback(destination.fallback) || (destination.threadId !== undefined && destination.threadId !== task.lastRunThreadId)) && {
                keepLastThread: true,
            }),
            goal:
                goal && goal.userId === task.userId
                    ? { description: goal.description ?? undefined, successCriteria: goal.successCriteria ?? undefined, title: goal.title }
                    : undefined,
            instructions: task.instructions,
            model: task.model ?? undefined,
            organizationId: task.organizationId ?? undefined,
            projectId,
            reasoningEffort: task.reasoningEffort ?? undefined,
            repair,
            reviewNote: task.reviewNote ?? undefined,
            runId: runId as Id<"taskRuns">,
            skillId: task.skillId ?? undefined,
            successCriteria: task.successCriteria ?? undefined,
            title: task.title,
            userId: task.userId,
        };
    });

/**
 * Where a round of `task` runs: the project it may file into and the thread it continues, re-read now. Run at
 * the claim, and again by the runner right before it writes (`runThreadProblem`), since a thread can be
 * moved, locked or start a chat reply in between. Write access, not read access, decides the project
 * (`writableProject`): a run never files into a project the owner could not move a thread into.
 */
const resolveRunPlace = async (ctx: QueryCtx, task: Doc<"tasks">, round: number) => {
    const project = task.projectId ? await writableProject(ctx, task.projectId, task.userId) : null;
    const cycle = task.activeCycle;
    // A repair round continues the thread its cycle's previous round ran in, where the attempt it repairs is: after a
    // passing fallback that is not the task's kept thread (`lastRunThreadId`).
    const previous =
        round > 0 && cycle
            ? await ctx.db
                  .query("taskRuns")
                  .withIndex("by_cycle_and_round", (q) => q.eq("cycle", cycle).eq("round", round - 1))
                  .first()
            : null;
    const keptThreadId = previous?.threadId ?? task.lastRunThreadId;
    const lastThread =
        task.recurring && task.runDestination && task.runDestination !== "new_thread" && keptThreadId
            ? await ctx.db.get("threads", keptThreadId as Id<"threads">)
            : null;
    const liveReply = lastThread
        ? await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: lastThread._id as string } })
        : null;
    const destination = pickRunThread({
        destination: task.runDestination,
        lastRunThreadId: keptThreadId,
        projectId: project?._id,
        recurring: task.recurring,
        round,
        thread: lastThread && { ...lastThread, busy: liveReply !== null },
        userId: task.userId,
    });
    // A project the owner can no longer file into is the first reason: the thread in it is then unusable too.
    const notice: TaskRunNoticeReason | undefined = task.projectId && !project ? "project_unwritable" : destination.fallback;

    return { destination, notice, project };
};

/**
 * The project a run may still file into, and its own instructions, re-read right before the run uses them: the
 * owner may have lost write access since the claim (left the organization). `null` when there is none.
 */
export const runProjectFor = internalQuery
    .input({ taskId: v.id("tasks") })
    .output(v.union(v.null(), v.object({ context: v.optional(v.string()), projectId: v.id("projects") })))
    .query(async ({ args, ctx }) => {
        const task = await ctx.db.get("tasks", args.taskId);
        const project = task?.projectId ? await writableProject(ctx, task.projectId, task.userId) : null;

        return project ? { projectId: project._id, ...(project.context && { context: project.context }) } : null;
    });

/**
 * Why the runner may no longer write into `threadId` for this round (moved, locked, a reply started since the
 * claim), or `null` when it still may. The reason is the one the task view shows.
 */
export const runThreadProblem = internalQuery
    .input({ cycle: v.string(), round: v.number(), taskId: v.id("tasks"), threadId: v.string() })
    .output(v.union(vTaskRunNoticeReason, v.null()))
    .query(async ({ args, ctx }) => {
        const task = await ctx.db.get("tasks", args.taskId);

        // A cancelled (or replaced) round writes into no kept thread: the thread may already be the newer cycle's.
        if (task?.activeCycle !== args.cycle) {
            return "thread_unavailable";
        }

        const { destination, notice } = await resolveRunPlace(ctx, task, args.round);

        return destination.threadId === args.threadId ? null : (notice ?? "thread_unavailable");
    });

/**
 * Records that a round started a new thread after all, because its thread changed between the claim and the run.
 * Only for the task's current cycle: a cancelled round's late action never overwrites a newer run's notice.
 */
export const recordRunNotice = internalMutation
    .input({ cycle: v.string(), reason: vTaskRunNoticeReason, taskId: v.id("tasks") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const task = await ctx.db.get("tasks", args.taskId);

        if (task?.activeCycle === args.cycle) {
            await ctx.db.patch("tasks", args.taskId, { lastRunNotice: { at: ctx.now, reason: args.reason } });
        }

        return null;
    });

/** Whether a round is still waiting for its outcome — a redelivered finisher checks this before paying for a verifier call. */
export const isRoundRunning = internalQuery
    .input({ runId: v.id("taskRuns") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get("taskRuns", args.runId);

        return run?.status === "running";
    });

/** What the verifier needs of a task, for a round completed after its claim (`finishCodingAgentRound`). */
export const getTaskForVerification = internalQuery
    .input({ taskId: v.id("tasks") })
    .output(v.union(v.object({ instructions: v.string(), successCriteria: v.optional(v.string()), title: v.string(), userId: v.string() }), v.null()))
    .query(async ({ args, ctx }) => {
        const task = await ctx.db.get("tasks", args.taskId);

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
    threadId: string | undefined,
): Promise<void> => {
    await notifyQuietly(ctx, {
        dedupeKey: `task:${run._id}`,
        emailOutcome: Boolean(detail),
        // A finished run opens its chat, where the result is. A run that needs review or failed is
        // acted on from the tasks board, where its review controls are, so that link stays.
        link: outcome === "success" && threadId ? `/chat/${threadId}` : "/tasks",
        outcome,
        title: task.title,
        type: "task",
        userId: task.userId,
        ...(detail && { body: detail }),
    });
};

/**
 * Finishes a claimed round and decides what happens next: done (and unblock
 * dependents), another repair round, a human review, or failed on an error.
 */
export const completeRound = internalMutation
    .input({
        /** The round ran in a fallback thread for a passing reason (`isPassingFallback`): the task keeps its thread. */
        keepLastThread: v.optional(v.boolean()),
        outcome: vRoundOutcome,
        runId: v.id("taskRuns"),
        threadId: v.optional(v.string()),
    })
    .output(v.union(v.null(), v.union(v.literal("done"), v.literal("repair"), v.literal("needs_review"), v.literal("failed"), v.literal("cancelled"))))
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get("taskRuns", args.runId);

        if (!run || run.status !== "running") {
            return null;
        }

        const { outcome } = args;
        const { now } = ctx;
        const finalAnswer = outcome.kind === "error" ? undefined : outcome.finalAnswer.slice(0, FINAL_ANSWER_MAX);
        // What every outcome records on the run row; absent values stay absent.
        const runResult = withoutUndefined({ completedAt: now, finalAnswer, threadId: args.threadId });
        const task = await ctx.db.get("tasks", run.taskId);

        if (!task || task.activeCycle !== run.cycle) {
            await ctx.db.patch("taskRuns", run._id, { ...runResult, status: "cancelled" });

            return "cancelled";
        }

        const lastRunThreadId = args.keepLastThread ? task.lastRunThreadId : (args.threadId ?? task.lastRunThreadId);

        if (outcome.kind === "error") {
            const error = outcome.error.slice(0, 2000);

            await ctx.db.patch("taskRuns", run._id, { ...runResult, error, status: "error" });
            await patchById(ctx.db, "tasks", task._id, { ...failedTaskPatch(error, now), lastRunThreadId });
            await notifyTaskRound(ctx, task, run, "failure", error, args.threadId ?? run.threadId);

            return "failed";
        }

        let next: "done" | "needs_review" | "repair";

        if (outcome.kind === "unverified") {
            // The answer is kept; the run says it is the check that failed.
            await ctx.db.patch("taskRuns", run._id, { ...runResult, error: UNVERIFIED_MESSAGE, status: "error" });
            next = "needs_review";
        } else {
            const verdict = {
                pass: outcome.verdict.pass,
                reasons: outcome.verdict.reasons,
                ...(outcome.verdict.repairInstructions && { repairInstructions: outcome.verdict.repairInstructions }),
            };

            await ctx.db.patch("taskRuns", run._id, { ...runResult, status: verdict.pass ? "passed" : "failed", verdict });
            next = decideAfterVerdict(verdict, run.round, task.maxRepairRounds);
        }

        if (next === "repair") {
            await ctx.db.patch("tasks", task._id, withoutUndefined({ lastRunThreadId, updatedAt: now }));
            await enqueueJob(internal.tasks.execute.runTaskRound, {
                cycle: run.cycle,
                origin: "repair",
                round: run.round + 1,
                taskId: task._id,
            });

            return "repair";
        }

        if (next === "needs_review") {
            await patchById(ctx.db, "tasks", task._id, {
                activeCycle: undefined,
                lastRunThreadId,
                resultSummary: summarise(finalAnswer),
                status: "needs_review",
                updatedAt: now,
            });
            await notifyTaskRound(ctx, task, run, "failure", summarise(finalAnswer), args.threadId ?? run.threadId);

            return "needs_review";
        }

        const done = { ...task, status: "done" as const };

        await patchById(ctx.db, "tasks", task._id, {
            activeCycle: undefined,
            lastError: undefined,
            lastRunThreadId,
            resultSummary: summarise(finalAnswer),
            reviewNote: undefined,
            status: "done",
            updatedAt: now,
        });
        await promoteDependents(ctx, done, now);
        await notifyTaskRound(ctx, task, run, "success", summarise(finalAnswer), args.threadId ?? run.threadId);

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
 * Stale rounds, then due recurrences. Rides on the trigger schedule's
 * every-minute tick (`triggers/schedule.ts:checkDueTriggers`) rather than a cron
 * of its own.
 *
 * Stale rounds go first: after an outage a round that stopped reporting is
 * failed before its slot is looked at, so the slot starts the catch-up run
 * instead of being skipped as "still running".
 */
export const checkDueTasks = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const { now } = ctx;

        const failStaleTask = async (task: Doc<"tasks">, message: string): Promise<void> => {
            const cycle = task.activeCycle;

            if (cycle) {
                const runs = await ctx.db
                    .query("taskRuns")
                    .withIndex("by_cycle_and_round", (q) => q.eq("cycle", cycle))
                    .take(20);

                for (const run of runs) {
                    if (run.status === "running") {
                        await ctx.db.patch("taskRuns", run._id, { completedAt: now, error: message, status: "error" });
                    }
                }
            }

            await patchById(ctx.db, "tasks", task._id, failedTaskPatch(message, now));
            // The inbox keeps the trace: a recurring task's catch-up may start in this same sweep, which clears
            // `lastError`, and a round that never started has no run row to show it.
            await notifyQuietly(ctx, {
                body: message,
                dedupeKey: `task-stale:${task._id}:${cycle ?? String(task.updatedAt)}`,
                emailOutcome: true,
                link: "/tasks",
                outcome: "failure",
                title: task.title,
                type: "task",
                userId: task.userId,
            });
        };

        for (const status of ["queued", "running"] as const) {
            const stale = await ctx.db
                .query("tasks")
                .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status).lt("updatedAt", now - STALE_AFTER_MS[status]))
                .take(SWEEP_BATCH);

            for (const task of stale) {
                await failStaleTask(task, STALE_MESSAGE[status]);
            }
        }

        const due = pickFairRecurrences(
            await ctx.db
                .query("tasks")
                .withIndex("by_recurring_and_nextRunAt", (q) => q.eq("recurring", true).lte("nextRunAt", now))
                .take(SWEEP_SCAN),
            MAX_RECURRENCES_PER_USER_PER_SWEEP,
            SWEEP_BATCH,
        );

        const statusesByUser = new Map<string, Map<string, TaskStatus>>();

        for (const dueTask of due) {
            if (dueTask.nextRunAt === undefined || !dueTask.cronExpression) {
                continue;
            }

            let task = dueTask;
            const stale = staleRoundMessage(task, now);

            // A dead round the bounded batch above did not reach: failed here, so its slot is the catch-up
            // rather than a slot skipped as "still running".
            if (stale) {
                await failStaleTask(task, stale);
                task = { ...task, activeCycle: undefined, status: "failed" };
            }

            // Advance first, from `now`, whatever happens next: a task that cannot start is not
            // re-examined every minute, and slots missed while the sweep was down collapse into
            // this one run. `updatedAt` is left alone, including on a skip: only a task that
            // really starts changes, and the stale-round check above reads `updatedAt` as the
            // run's last sign of life.
            const advance = { nextRunAt: nextRecurrenceAt(dueTask.cronExpression, now) };
            // The skip a slot this sweep cannot run leaves on the task: the latest real slot, or nothing when the
            // schedule had no real slot to skip. Bounded work, so a skipped task never holds up the rest of the batch.
            const { cronExpression, nextRunAt: dueSlot } = dueTask;
            const skipRecord = (reason: TaskSkipReason) => {
                const at = latestSlotAtOrBefore(cronExpression, dueSlot, now, dueTask.createdAt);

                return at === undefined ? {} : { lastSkippedAt: at, lastSkipReason: reason };
            };
            const skipped = recurrenceSkipReason(task.status);

            if (skipped) {
                await ctx.db.patch("tasks", task._id, { ...advance, ...skipRecord(skipped) });

                continue;
            }

            await ctx.db.patch("tasks", task._id, advance);

            let statusById = statusesByUser.get(task.userId);

            if (!statusById) {
                statusById = statusMap(await loadUserTasks(ctx, task.userId));
                statusesByUser.set(task.userId, statusById);
            }

            statusById.set(task._id as string, task.status);

            const landed = await startTask(ctx, task, "schedule", statusById, now);

            if (landed) {
                statusById.set(task._id as string, landed);
            }

            // Its dependencies are not done: this slot does not run now, so it is recorded like any other skip.
            const blockedSkip = landed === "blocked" ? skipRecord("blocked") : {};

            if ("lastSkippedAt" in blockedSkip) {
                await ctx.db.patch("tasks", task._id, blockedSkip);
            }
        }

        return null;
    });
