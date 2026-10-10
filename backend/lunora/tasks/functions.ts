/**
 * Goals and tasks — the public surface.
 *
 * A task is instructions an agent works autonomously, checked by a verifier
 * against success criteria (`tasks/execute.ts`); the state machine behind "run",
 * "cancel" and the review decisions lives in `tasks/internal.ts`. Every row here
 * is the caller's own: each procedure loads by id and compares `userId`, and a
 * row that belongs to someone else answers NOT_FOUND, never FORBIDDEN, so ids
 * cannot be probed.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchById, patchRow } from "../lib/patch";
import { noteShardDue } from "../lib/shard-housekeeping";
import type { SkillAccessSubject } from "../skills/access";
import { canReadSkill } from "../skills/access";
import { MAX_ENABLED_SKILLS } from "../skills/constants";
import type { TaskStatus } from "./logic";
import {
    areDependenciesDone,
    canTransition,
    computeGoalProgress,
    DEFAULT_MAX_REPAIR_ROUNDS,
    findDependencyCycle,
    isTaskModelAllowed,
    MAX_DEPENDENCIES,
    MAX_GOALS_PER_USER,
    MAX_RECURRING_TASKS_PER_USER,
    MAX_REPAIR_ROUNDS_LIMIT,
    MAX_TASKS_PER_USER,
    nextRecurrenceAt,
    TASK_CRITERIA_MAX,
    TASK_INSTRUCTIONS_MAX,
    TASK_NOTE_MAX,
    TASK_TITLE_MAX,
    validateParent,
} from "./logic";
import { isValidCronExpression } from "../triggers/schedule";
import { requireTaskAccount } from "./account";
import { loadUserTasks, promoteDependents, queueCycle, startTask, statusMap } from "./internal";
import { vGoalStatus, vTaskRunOrigin, vTaskRunStatus, vTaskStatus, vVerdict } from "./validators";
import { isValidBranchName, parseRepoUrl } from "../coding-agents/commands";
import { vCodingAgentAssignment } from "../coding-agents/validators";
import { MAX_LENGTH } from "../lib/validators";

/** Runs shown per task in the history panel. */
const MAX_RUNS_LISTED = 50;

/** Runs removed per task delete; a task with more keeps its oldest rows until the account is deleted. */
const MAX_RUNS_DELETED = 500;

/** "Run" on a task in one of these is a no-op that reports where it already is. */
const ALREADY_STARTED: ReadonlySet<TaskStatus> = new Set(["blocked", "queued", "running"]);

// ─── Output shapes ───────────────────────────────────────────────────────────

const vTaskBoard = v.object({
    goals: v.array(
        v.object({
            _id: v.id("goals"),
            createdAt: v.number(),
            description: v.union(v.string(), v.null()),
            progress: v.object({
                blocked: v.number(),
                done: v.number(),
                failed: v.number(),
                inProgress: v.number(),
                needsReview: v.number(),
                percent: v.number(),
                total: v.number(),
            }),
            status: vGoalStatus,
            successCriteria: v.union(v.string(), v.null()),
            title: v.string(),
            updatedAt: v.number(),
        }),
    ),
    tasks: v.array(
        v.object({
            _id: v.id("tasks"),
            attemptCount: v.number(),
            codingAgent: v.union(vCodingAgentAssignment, v.null()),
            createdAt: v.number(),
            cronExpression: v.union(v.string(), v.null()),
            dependsOn: v.array(v.id("tasks")),
            goalId: v.union(v.id("goals"), v.null()),
            instructions: v.string(),
            lastError: v.union(v.string(), v.null()),
            lastRunThreadId: v.union(v.string(), v.null()),
            maxRepairRounds: v.number(),
            model: v.union(v.string(), v.null()),
            nextRunAt: v.union(v.number(), v.null()),
            parentTaskId: v.union(v.id("tasks"), v.null()),
            resultSummary: v.union(v.string(), v.null()),
            reviewNote: v.union(v.string(), v.null()),
            skillId: v.union(v.id("skills"), v.null()),
            status: vTaskStatus,
            successCriteria: v.union(v.string(), v.null()),
            title: v.string(),
            updatedAt: v.number(),
        }),
    ),
});

const vTaskRuns = v.array(
    v.object({
        _id: v.id("taskRuns"),
        completedAt: v.union(v.number(), v.null()),
        error: v.union(v.string(), v.null()),
        finalAnswer: v.union(v.string(), v.null()),
        origin: vTaskRunOrigin,
        round: v.number(),
        startedAt: v.number(),
        status: vTaskRunStatus,
        threadId: v.union(v.string(), v.null()),
        verdict: v.union(vVerdict, v.null()),
    }),
);

const vSkillOptions = v.array(v.object({ _id: v.id("skills"), name: v.string(), slug: v.string() }));

const vRunResult = v.object({ status: vTaskStatus });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const requireOwnedTask = async (ctx: QueryCtx, taskId: Id<"tasks">, userId: string): Promise<Doc<"tasks">> => {
    const task = await ctx.db.get(taskId);

    if (!task || task.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Task not found");
    }

    return task;
};

const requireOwnedGoal = async (ctx: QueryCtx, goalId: Id<"goals">, userId: string): Promise<Doc<"goals">> => {
    const goal = await ctx.db.get(goalId);

    if (!goal || goal.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Goal not found");
    }

    return goal;
};

/** Trims, and turns an empty optional into `undefined` so it clears the column. */
const optionalText = (value: string | undefined, max: number, label: string): string | undefined => {
    const trimmed = value?.trim();

    if (!trimmed) {
        return undefined;
    }

    if (trimmed.length > max) {
        throw new LunoraError("BAD_REQUEST", `${label} must be ${String(max)} characters or less`);
    }

    return trimmed;
};

const requiredText = (value: string, max: number, label: string): string => {
    const text = optionalText(value, max, label);

    if (!text) {
        throw new LunoraError("BAD_REQUEST", `${label} is required`);
    }

    return text;
};

/** Only a skill the user can read AND has enabled can be assigned — the same bar a slash command meets. */
const requireUsableSkill = async (ctx: QueryCtx, skillId: Id<"skills">, subject: SkillAccessSubject): Promise<void> => {
    const { userId } = subject;
    const skill = await ctx.db.skills.findFirst({ where: { _id: skillId } });

    if (!skill || !canReadSkill(skill, subject)) {
        throw new LunoraError("NOT_FOUND", "Skill not found");
    }

    const userSkill = await ctx.db
        .query("userSkills")
        .withIndex("by_user_and_skill", (q) => q.eq("userId", userId).eq("skillId", skillId))
        .first();

    if (!userSkill?.enabled) {
        throw new LunoraError("BAD_REQUEST", `Enable the skill '/${skill.slug}' before assigning it to a task`);
    }
};

interface TaskDefinitionInput {
    codingAgent?: { agent: "claude_code" | "codex"; branch?: string; openPr?: boolean; repoUrl: string };
    cronExpression?: string;
    dependsOn: Id<"tasks">[];
    goalId?: Id<"goals">;
    instructions: string;
    maxRepairRounds?: number;
    model?: string;
    parentTaskId?: Id<"tasks">;
    skillId?: Id<"skills">;
    successCriteria?: string;
    title: string;
}

/**
 * A coding-agent assignee, validated and with its repository normalised — or
 * `undefined` for the chat agent. It works the repository, so it takes neither a
 * skill nor a model; refusing the combination beats silently ignoring half of it.
 */
const resolveCodingAgent = (input: TaskDefinitionInput): TaskDefinitionInput["codingAgent"] => {
    if (!input.codingAgent) {
        return undefined;
    }

    if (input.skillId || input.model) {
        throw new LunoraError("BAD_REQUEST", "A task assigned to a coding agent cannot also have a skill or a model");
    }

    let repoUrl: string;

    try {
        repoUrl = parseRepoUrl(input.codingAgent.repoUrl).cloneUrl;
    } catch (error) {
        throw new LunoraError("BAD_REQUEST", error instanceof Error ? error.message : "Invalid repository");
    }

    const branch = input.codingAgent.branch?.trim() || undefined;

    if (branch !== undefined && !isValidBranchName(branch)) {
        throw new LunoraError("BAD_REQUEST", "Invalid branch name");
    }

    return { agent: input.codingAgent.agent, ...(branch && { branch }), openPr: input.codingAgent.openPr === true, repoUrl };
};

/**
 * Validates a task definition against the caller's other tasks and returns the
 * columns to write. `taskId` is the task being edited (undefined on create).
 *
 * `organizationId` is the caller's ACTIVE organization from the cRPC
 * user — resolved from the session and membership-checked there
 * (`resolveActiveMembership`), never taken from args. It is stored on the task
 * so a headless run can resolve a skill shared with that organization.
 */
const resolveDefinition = async (
    ctx: MutationCtx,
    { organizationId, userId }: { organizationId?: string; userId: string },
    input: TaskDefinitionInput,
    tasks: ReadonlyArray<Doc<"tasks">>,
    taskId?: Id<"tasks">,
) => {
    const cronExpression = optionalText(input.cronExpression, 100, "Schedule");

    if (cronExpression && !isValidCronExpression(cronExpression)) {
        throw new LunoraError("BAD_REQUEST", 'Schedule must be a 5-field cron expression (UTC), e.g. "0 9 * * 1"');
    }

    const title = requiredText(input.title, TASK_TITLE_MAX, "Title");
    const instructions = requiredText(input.instructions, TASK_INSTRUCTIONS_MAX, "Instructions");
    const successCriteria = optionalText(input.successCriteria, TASK_CRITERIA_MAX, "Success criteria");
    const model = optionalText(input.model, 200, "Model");

    if (model && !isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id))) {
        throw new LunoraError("BAD_REQUEST", `The model '${model}' is not available for tasks`);
    }

    const maxRepairRounds = input.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;

    if (!Number.isSafeInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > MAX_REPAIR_ROUNDS_LIMIT) {
        throw new LunoraError("BAD_REQUEST", `Repair rounds must be a whole number from 0 to ${String(MAX_REPAIR_ROUNDS_LIMIT)}`);
    }

    const byId = new Map(tasks.map((task) => [task._id as string, task]));

    if (cronExpression && tasks.filter((task) => task.recurring && task._id !== taskId).length >= MAX_RECURRING_TASKS_PER_USER) {
        throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_RECURRING_TASKS_PER_USER)} recurring tasks`);
    }

    const dependsOn = [...new Set(input.dependsOn)];

    if (dependsOn.length > MAX_DEPENDENCIES) {
        throw new LunoraError("BAD_REQUEST", `A task can depend on at most ${String(MAX_DEPENDENCIES)} others`);
    }

    // `byId` holds only the caller's tasks, so an id that is not in it is
    // someone else's or gone — the same answer either way.
    if (dependsOn.some((id) => !byId.has(id))) {
        throw new LunoraError("NOT_FOUND", "A dependency was not found");
    }

    const selfKey = (taskId as string | undefined) ?? "__new__";
    const graph = new Map(tasks.map((task) => [task._id as string, task.dependsOn as string[]]));
    const cycle = findDependencyCycle(selfKey, dependsOn, graph);

    if (cycle) {
        const names = cycle.map((id) => (id === selfKey ? title : (byId.get(id)?.title ?? id)));

        throw new LunoraError("BAD_REQUEST", `These dependencies form a cycle: ${names.join(" → ")}`);
    }

    if (input.parentTaskId) {
        if (!byId.has(input.parentTaskId)) {
            throw new LunoraError("NOT_FOUND", "Parent task not found");
        }

        const parents = new Map(tasks.map((task) => [task._id as string, (task.parentTaskId ?? undefined) as string | undefined]));
        const problem = validateParent(taskId, input.parentTaskId, parents);

        if (problem === "cycle") {
            throw new LunoraError("BAD_REQUEST", "A task cannot be a subtask of itself or of its own subtasks");
        }

        if (problem === "too_deep") {
            throw new LunoraError("BAD_REQUEST", "Subtasks are nested too deeply");
        }
    }

    if (input.goalId) {
        await requireOwnedGoal(ctx, input.goalId, userId);
    }

    if (input.skillId) {
        await requireUsableSkill(ctx, input.skillId, { organizationId, userId });
    }

    const codingAgent = resolveCodingAgent(input);

    return {
        codingAgent,
        cronExpression,
        dependsOn,
        goalId: input.goalId,
        instructions,
        maxRepairRounds,
        model,
        organizationId,
        parentTaskId: input.parentTaskId,
        recurring: cronExpression !== undefined,
        skillId: input.skillId,
        successCriteria,
        title,
    };
};

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Everything the Tasks page renders: the caller's goals, with progress derived from their tasks, and the tasks. */
export const getTaskBoard = authQuery
    .input({})
    .output(v.from(vTaskBoard))
    .query(async ({ ctx }): Promise<Infer<typeof vTaskBoard>> => {
        const { userId } = ctx.user;
        const [goals, tasks] = await Promise.all([
            ctx.db
                .query("goals")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
                .take(MAX_GOALS_PER_USER),
            loadUserTasks(ctx, userId),
        ]);

        return {
            goals: goals.map((goal) => {
                return {
                    _id: goal._id,
                    createdAt: goal.createdAt,
                    description: goal.description ?? null,
                    progress: computeGoalProgress(tasks.filter((task) => task.goalId === goal._id).map((task) => task.status)),
                    status: goal.status,
                    successCriteria: goal.successCriteria ?? null,
                    title: goal.title,
                    updatedAt: goal.updatedAt,
                };
            }),
            tasks: tasks.map((task) => {
                return {
                    _id: task._id,
                    attemptCount: task.attemptCount,
                    codingAgent: task.codingAgent ?? null,
                    createdAt: task.createdAt,
                    cronExpression: task.cronExpression ?? null,
                    dependsOn: task.dependsOn,
                    goalId: task.goalId ?? null,
                    instructions: task.instructions,
                    lastError: task.lastError ?? null,
                    lastRunThreadId: task.lastRunThreadId ?? null,
                    maxRepairRounds: task.maxRepairRounds,
                    model: task.model ?? null,
                    nextRunAt: task.nextRunAt ?? null,
                    parentTaskId: task.parentTaskId ?? null,
                    resultSummary: task.resultSummary ?? null,
                    reviewNote: task.reviewNote ?? null,
                    skillId: task.skillId ?? null,
                    status: task.status,
                    successCriteria: task.successCriteria ?? null,
                    title: task.title,
                    updatedAt: task.updatedAt,
                };
            }),
        };
    });

/** A task's run history, newest first, with the verifier's verdict on each round. */
export const getTaskRuns = authQuery
    .input({ limit: v.optional(v.number()), taskId: v.id("tasks") })
    .output(v.from(vTaskRuns))
    .query(async ({ args, ctx }): Promise<Infer<typeof vTaskRuns>> => {
        await requireOwnedTask(ctx, args.taskId, ctx.user.userId);

        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), MAX_RUNS_LISTED);
        const runs = await ctx.db
            .query("taskRuns")
            .withIndex("by_task_and_startedAt", (q) => q.eq("taskId", args.taskId))
            .order("desc")
            .take(limit);

        return runs.map((run) => {
            return {
                _id: run._id,
                completedAt: run.completedAt ?? null,
                error: run.error ?? null,
                finalAnswer: run.finalAnswer ?? null,
                origin: run.origin,
                round: run.round,
                startedAt: run.startedAt,
                status: run.status,
                threadId: run.threadId ?? null,
                verdict: run.verdict ?? null,
            };
        });
    });

/** Skills the caller may assign to a task: enabled, and still readable by them. */
export const listTaskSkillOptions = authQuery
    .input({})
    .output(v.from(vSkillOptions))
    .query(async ({ ctx }): Promise<Infer<typeof vSkillOptions>> => {
        const { userId } = ctx.user;
        const enabled = await ctx.db
            .query("userSkills")
            .withIndex("by_user_and_enabled", (q) => q.eq("userId", userId).eq("enabled", true))
            .take(MAX_ENABLED_SKILLS);
        const skills = await Promise.all(enabled.map((row) => ctx.db.skills.findFirst({ where: { _id: row.skillId } })));
        const seen = new Set<string>();

        return skills.flatMap((skill) => {
            if (!skill || seen.has(skill._id as string) || !canReadSkill(skill, { organizationId: ctx.user.activeOrganization?.id, userId })) {
                return [];
            }

            seen.add(skill._id as string);

            return [{ _id: skill._id, name: skill.name, slug: skill.slug }];
        });
    });

// ─── Goals ───────────────────────────────────────────────────────────────────

export const createGoal = authMutation
    .use(rateLimit("tasks/create"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        successCriteria: v.optional(v.string().max(MAX_LENGTH.text)),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.object({ goalId: v.id("goals") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const existing = await ctx.db
            .query("goals")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
            .take(MAX_GOALS_PER_USER);

        if (existing.length >= MAX_GOALS_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_GOALS_PER_USER)} goals`);
        }

        const now = ctx.now;
        const goalId = await ctx.db.insert("goals", {
            createdAt: now,
            description: optionalText(args.description, TASK_INSTRUCTIONS_MAX, "Description"),
            status: "active",
            successCriteria: optionalText(args.successCriteria, TASK_CRITERIA_MAX, "Success criteria"),
            title: requiredText(args.title, TASK_TITLE_MAX, "Title"),
            updatedAt: now,
            userId,
        });

        ctx.log.event("tasks.create_goal", { goalId });

        return { goalId };
    });

export const updateGoal = authMutation
    .use(rateLimit("tasks/update"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        goalId: v.id("goals"),
        status: v.union(v.literal("active"), v.literal("completed"), v.literal("archived")),
        successCriteria: v.optional(v.string().max(MAX_LENGTH.text)),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await requireOwnedGoal(ctx, args.goalId, ctx.user.userId);

        await patchById(ctx.db, args.goalId, {
            description: optionalText(args.description, TASK_INSTRUCTIONS_MAX, "Description"),
            status: args.status,
            successCriteria: optionalText(args.successCriteria, TASK_CRITERIA_MAX, "Success criteria"),
            title: requiredText(args.title, TASK_TITLE_MAX, "Title"),
            updatedAt: ctx.now,
        });

        ctx.log.event("tasks.update_goal", { goalId: args.goalId });

        return null;
    });

/** Deletes the goal only; its tasks stay, unassigned. */
export const deleteGoal = authMutation
    .use(rateLimit("tasks/delete"))
    .input({ goalId: v.id("goals") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireOwnedGoal(ctx, args.goalId, userId);

        const tasks = await ctx.db
            .query("tasks")
            .withIndex("by_user_and_goal", (q) => q.eq("userId", userId).eq("goalId", args.goalId))
            .take(MAX_TASKS_PER_USER);
        const now = ctx.now;

        await Promise.all(tasks.map((task) => patchRow(ctx.db, task, { goalId: undefined, updatedAt: now })));
        await ctx.db.delete(args.goalId);

        ctx.log.event("tasks.delete_goal", { detachedTaskCount: tasks.length, goalId: args.goalId });

        return null;
    });

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const createTask = authMutation
    .use(rateLimit("tasks/create"))
    .input({
        codingAgent: v.optional(vCodingAgentAssignment),
        cronExpression: v.optional(v.string().max(MAX_LENGTH.short)),
        dependsOn: v.array(v.id("tasks")),
        goalId: v.optional(v.id("goals")),
        instructions: v.string().max(MAX_LENGTH.document),
        maxRepairRounds: v.optional(v.number()),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        parentTaskId: v.optional(v.id("tasks")),
        skillId: v.optional(v.id("skills")),
        successCriteria: v.optional(v.string().max(MAX_LENGTH.text)),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.object({ taskId: v.id("tasks") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireTaskAccount(ctx, userId);

        const tasks = await loadUserTasks(ctx, userId);

        if (tasks.length >= MAX_TASKS_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_TASKS_PER_USER)} tasks`);
        }

        const definition = await resolveDefinition(ctx, { organizationId: ctx.user.activeOrganization?.id, userId }, args, tasks);
        const now = ctx.now;
        const taskId = await ctx.db.insert("tasks", {
            ...definition,
            attemptCount: 0,
            createdAt: now,
            nextRunAt: definition.cronExpression ? nextRecurrenceAt(definition.cronExpression, now) : undefined,
            status: "todo",
            updatedAt: now,
            userId,
        });

        if (definition.cronExpression) {
            // The root tick only visits shards with timed work due (`lib/shard-housekeeping.ts`).
            await noteShardDue(ctx, nextRecurrenceAt(definition.cronExpression, now), userId);
        }

        ctx.log.event("tasks.create_task", { recurring: Boolean(definition.cronExpression), taskId });

        return { taskId };
    });

/** Replaces a task's definition. Refused while it is queued or running — the run would not see the change. */
export const updateTask = authMutation
    .use(rateLimit("tasks/update"))
    .input({
        codingAgent: v.optional(vCodingAgentAssignment),
        cronExpression: v.optional(v.string().max(MAX_LENGTH.short)),
        dependsOn: v.array(v.id("tasks")),
        goalId: v.optional(v.id("goals")),
        instructions: v.string().max(MAX_LENGTH.document),
        maxRepairRounds: v.optional(v.number()),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        parentTaskId: v.optional(v.id("tasks")),
        skillId: v.optional(v.id("skills")),
        successCriteria: v.optional(v.string().max(MAX_LENGTH.text)),
        taskId: v.id("tasks"),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const task = await requireOwnedTask(ctx, args.taskId, userId);

        if (task.status === "queued" || task.status === "running") {
            throw new LunoraError("CONFLICT", "Cancel the running task before editing it");
        }

        const tasks = await loadUserTasks(ctx, userId);
        const definition = await resolveDefinition(ctx, { organizationId: ctx.user.activeOrganization?.id, userId }, args, tasks, args.taskId);
        const now = ctx.now;
        let nextRunAt: number | undefined;

        if (definition.cronExpression) {
            // Keep the pending firing unless the schedule itself changed.
            nextRunAt = definition.cronExpression === task.cronExpression && task.nextRunAt ? task.nextRunAt : nextRecurrenceAt(definition.cronExpression, now);
        }

        await patchById(ctx.db, args.taskId, {
            codingAgent: definition.codingAgent,
            cronExpression: definition.cronExpression,
            dependsOn: definition.dependsOn,
            goalId: definition.goalId,
            instructions: definition.instructions,
            maxRepairRounds: definition.maxRepairRounds,
            model: definition.model,
            nextRunAt,
            organizationId: definition.organizationId,
            parentTaskId: definition.parentTaskId,
            recurring: definition.recurring,
            skillId: definition.skillId,
            successCriteria: definition.successCriteria,
            title: definition.title,
            updatedAt: now,
        });

        if (nextRunAt !== undefined) {
            await noteShardDue(ctx, nextRunAt, userId);
        }

        // Dropping the dependency it was waiting on lets a blocked task go.
        if (task.status === "blocked" && areDependenciesDone(definition.dependsOn, statusMap(tasks))) {
            await queueCycle(ctx, task, "dependency", now);
        }

        ctx.log.event("tasks.update_task", { recurring: Boolean(definition.cronExpression), taskId: args.taskId });

        return null;
    });

/**
 * Deletes a task and its run history. Dependents lose the edge — and a blocked
 * one this was the last thing holding back is queued, since a dependency that no
 * longer exists cannot be waited on. Subtasks become top-level.
 */
export const deleteTask = authMutation
    .use(rateLimit("tasks/delete"))
    .input({ taskId: v.id("tasks") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const task = await requireOwnedTask(ctx, args.taskId, userId);
        const now = ctx.now;

        const runs = await ctx.db
            .query("taskRuns")
            .withIndex("by_task_and_startedAt", (q) => q.eq("taskId", task._id))
            .take(MAX_RUNS_DELETED);

        await Promise.all(runs.map((run) => ctx.db.delete(run._id)));
        await ctx.db.delete(task._id);

        const remaining = await loadUserTasks(ctx, userId);
        const tasks = remaining.filter((other) => other._id !== task._id);
        const statusById = statusMap(tasks);

        for (const other of tasks) {
            const patch: { dependsOn?: Id<"tasks">[]; parentTaskId?: undefined } = {};

            if (other.dependsOn.includes(task._id)) {
                patch.dependsOn = other.dependsOn.filter((id) => id !== task._id);
            }

            if (other.parentTaskId === task._id) {
                patch.parentTaskId = undefined;
            }

            if (Object.keys(patch).length === 0) {
                continue;
            }

            await patchRow(ctx.db, other, { ...patch, updatedAt: now });

            if (patch.dependsOn && other.status === "blocked" && areDependenciesDone(patch.dependsOn, statusById)) {
                await queueCycle(ctx, other, "dependency", now);
            }
        }

        ctx.log.event("tasks.delete_task", { deletedRunCount: runs.length, taskId: task._id });

        return null;
    });

/** Starts a task: queued when its dependencies are done, blocked until they are. */
export const runTask = authMutation
    .use(rateLimit("tasks/run"))
    .input({ taskId: v.id("tasks") })
    .output(v.from(vRunResult))
    .mutation(async ({ args, ctx }): Promise<Infer<typeof vRunResult>> => {
        const { userId } = ctx.user;
        const task = await requireOwnedTask(ctx, args.taskId, userId);

        await requireTaskAccount(ctx, userId);

        if (ALREADY_STARTED.has(task.status)) {
            return { status: task.status };
        }

        if (task.status === "needs_review") {
            throw new LunoraError("CONFLICT", "This task is waiting for your review");
        }

        const now = ctx.now;

        // A manual run starts clean; a reviewer's note belongs to "retry with note".
        await patchById(ctx.db, task._id, { reviewNote: undefined });

        const landed = await startTask(ctx, task, "manual", statusMap(await loadUserTasks(ctx, userId)), now);

        if (!landed) {
            throw new LunoraError("CONFLICT", "This task cannot be started right now");
        }

        ctx.log.event("tasks.run_task", { status: landed, taskId: task._id });

        return { status: landed };
    });

/** Stops a queued, blocked or running task. A round already in flight finishes in the background and is recorded as cancelled. */
export const cancelTask = authMutation
    .use(rateLimit("tasks/update"))
    .input({ taskId: v.id("tasks") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const task = await requireOwnedTask(ctx, args.taskId, ctx.user.userId);

        if (!canTransition(task.status, "todo")) {
            throw new LunoraError("CONFLICT", "Only a queued, blocked or running task can be cancelled");
        }

        await patchById(ctx.db, task._id, { activeCycle: undefined, status: "todo", updatedAt: ctx.now });

        ctx.log.event("tasks.cancel_task", { taskId: task._id });

        return null;
    });

/**
 * The human in the loop, for a task the verifier would not pass:
 * approve (done — and dependents unblock), reject (failed), or retry with a
 * note the next run is given.
 */
export const reviewTask = authMutation
    .use(rateLimit("tasks/run"))
    .input({
        decision: v.union(v.literal("approve"), v.literal("reject"), v.literal("retry")),
        note: v.optional(v.string().max(MAX_LENGTH.long)),
        taskId: v.id("tasks"),
    })
    .output(v.from(vRunResult))
    .mutation(async ({ args, ctx }): Promise<Infer<typeof vRunResult>> => {
        const { userId } = ctx.user;
        const task = await requireOwnedTask(ctx, args.taskId, userId);

        if (task.status !== "needs_review") {
            throw new LunoraError("CONFLICT", "This task is not waiting for review");
        }

        const now = ctx.now;

        if (args.decision === "approve") {
            await patchById(ctx.db, task._id, { lastError: undefined, reviewNote: undefined, status: "done", updatedAt: now });
            await promoteDependents(ctx, { ...task, status: "done" }, now);

            ctx.log.event("tasks.review_task", { decision: args.decision, taskId: task._id });
            return { status: "done" };
        }

        if (args.decision === "reject") {
            await ctx.db.patch(task._id, { lastError: "Rejected in review", status: "failed", updatedAt: now });

            ctx.log.event("tasks.review_task", { decision: args.decision, taskId: task._id });
            return { status: "failed" };
        }

        await requireTaskAccount(ctx, userId);

        const reviewNote = optionalText(args.note, TASK_NOTE_MAX, "Note");

        await patchById(ctx.db, task._id, { reviewNote });

        const landed = await startTask(ctx, task, "retry", statusMap(await loadUserTasks(ctx, userId)), now);

        ctx.log.event("tasks.review_task", { decision: args.decision, taskId: task._id });

        return { status: (landed ?? task.status) satisfies TaskStatus };
    });
