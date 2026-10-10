/**
 * Pure helpers for the Tasks page: the board's column order, the task form's
 * shape and validation, the schedule presets, and the status transitions the
 * page announces as toasts. The backend (`backend/lunora/tasks/logic.ts`)
 * re-validates everything here; this only keeps the form honest.
 */
import type { ReturnOf } from "@lunora/react";
import type { ApiTypes } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

export type TaskBoard = ReturnOf<ApiTypes["tasks"]["functions"]["getTaskBoard"]>;

export type BoardTask = TaskBoard["tasks"][number];

export type BoardGoal = TaskBoard["goals"][number];

export type TaskStatus = BoardTask["status"];

export type TaskRun = ReturnOf<ApiTypes["tasks"]["functions"]["getTaskRuns"]>[number];

/** Board column order: what needs a human first, then work in flight, then the rest. */
export const STATUS_ORDER: ReadonlyArray<TaskStatus> = ["needs_review", "running", "queued", "blocked", "todo", "failed", "done"];

export const TITLE_MAX = 200;

export const INSTRUCTIONS_MAX = 20_000;

export const CRITERIA_MAX = 5000;

export const NOTE_MAX = 5000;

export const MAX_REPAIR_ROUNDS = 5;

export const DEFAULT_REPAIR_ROUNDS = 2;

/**
 * Why a `needs_review` task is waiting, read off its newest run (`runs` is
 * newest first, as `getTaskRuns` returns it). The backend records a round whose
 * verifier could not run as an `error` run that still carries the answer, and a
 * run error that is not that fails the task instead of asking for review — so
 * an `error` run behind a review means nobody checked the answer.
 */
export const reviewReason = (runs: ReadonlyArray<Pick<TaskRun, "status">> | undefined): "not_passed" | "unverified" =>
    runs?.[0]?.status === "error" ? "unverified" : "not_passed";

/** Whether a task is in flight — editing is refused server-side until it is cancelled. */
export const isInFlight = (status: TaskStatus): boolean => status === "queued" || status === "running";

export const groupByStatus = (tasks: ReadonlyArray<BoardTask>): Map<TaskStatus, BoardTask[]> => {
    const groups = new Map<TaskStatus, BoardTask[]>(STATUS_ORDER.map((status) => [status, []]));

    for (const task of tasks) {
        groups.get(task.status)?.push(task);
    }

    for (const group of groups.values()) {
        group.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    return groups;
};

// ─── Form ────────────────────────────────────────────────────────────────────

/** Who works the task: the chat agent (optionally a skill), or a coding agent on a repository. */
export type TaskAssignee = "chat" | "claude_code" | "codex";

export interface TaskFormValues {
    assignee: TaskAssignee;
    /** Coding-agent assignee only: the branch to check out; empty for the default branch. */
    branch: string;
    cronExpression: string;
    dependsOn: Id<"tasks">[];
    goalId: Id<"goals"> | "";
    instructions: string;
    maxRepairRounds: number;
    model: string | undefined;
    /** Coding-agent assignee only. */
    openPr: boolean;
    parentTaskId: Id<"tasks"> | "";
    /** Coding-agent assignee only: https:// URL or GitHub owner/repo. */
    repoUrl: string;
    skillId: Id<"skills"> | "";
    successCriteria: string;
    title: string;
}

export const getTaskFormDefaults = (task?: BoardTask | null, goalId?: Id<"goals"> | null): TaskFormValues => {
    return {
        assignee: task?.codingAgent?.agent ?? "chat",
        branch: task?.codingAgent?.branch ?? "",
        cronExpression: task?.cronExpression ?? "",
        dependsOn: task?.dependsOn ?? [],
        goalId: task?.goalId ?? goalId ?? "",
        instructions: task?.instructions ?? "",
        maxRepairRounds: task?.maxRepairRounds ?? DEFAULT_REPAIR_ROUNDS,
        model: task?.model ?? undefined,
        openPr: task?.codingAgent?.openPr ?? false,
        parentTaskId: task?.parentTaskId ?? "",
        repoUrl: task?.codingAgent?.repoUrl ?? "",
        skillId: task?.skillId ?? "",
        successCriteria: task?.successCriteria ?? "",
        title: task?.title ?? "",
    };
};

export type TaskFormErrorKey =
    "cronInvalid" | "instructionsRequired" | "instructionsTooLong" | "titleRequired" | "titleTooLong" | "criteriaTooLong" | "repoInvalid" | "repoRequired";

// https:// URL or GitHub `owner/repo`; the backend validates the rest.
const REPO_RE = /^(?:https:\/\/\S+|[\w.-]+\/[\w.-]+)$/u;

// Mirrors the backend's accepted parts: `*`, `n`, `*/s`, `n/s` or `a-b`.
const CRON_PART_RE = /^(?:(?:\*|\d{1,2})(?:\/\d{1,2})?|\d{1,2}-\d{1,2})$/u;

const WHITESPACE_RE = /\s+/u;

/** A light shape check; the backend checks field ranges and has the final word. */
export const looksLikeCron = (expression: string): boolean => {
    const fields = expression.trim().split(WHITESPACE_RE);

    return fields.length === 5 && fields.every((field) => field.split(",").every((part) => CRON_PART_RE.test(part)));
};

export const validateTaskForm = (values: TaskFormValues): Partial<Record<keyof TaskFormValues, TaskFormErrorKey>> => {
    const errors: Partial<Record<keyof TaskFormValues, TaskFormErrorKey>> = {};
    const title = values.title.trim();
    const instructions = values.instructions.trim();

    if (!title) {
        errors.title = "titleRequired";
    } else if (title.length > TITLE_MAX) {
        errors.title = "titleTooLong";
    }

    if (!instructions) {
        errors.instructions = "instructionsRequired";
    } else if (instructions.length > INSTRUCTIONS_MAX) {
        errors.instructions = "instructionsTooLong";
    }

    if (values.successCriteria.trim().length > CRITERIA_MAX) {
        errors.successCriteria = "criteriaTooLong";
    }

    if (values.cronExpression.trim() && !looksLikeCron(values.cronExpression)) {
        errors.cronExpression = "cronInvalid";
    }

    if (values.assignee !== "chat") {
        const repoUrl = values.repoUrl.trim();

        if (!repoUrl) {
            errors.repoUrl = "repoRequired";
        } else if (!REPO_RE.test(repoUrl)) {
            errors.repoUrl = "repoInvalid";
        }
    }

    return errors;
};

/**
 * The mutation payload: empty optionals become absent, which the backend reads as "unset".
 * A coding-agent assignee sends no skill or model — the backend refuses the combination.
 */
export const toTaskPayload = (values: TaskFormValues) => {
    const isCodingAgent = values.assignee !== "chat";

    return {
        codingAgent:
            values.assignee === "chat"
                ? undefined
                : { agent: values.assignee, branch: values.branch.trim() || undefined, openPr: values.openPr, repoUrl: values.repoUrl.trim() },
        cronExpression: values.cronExpression.trim() || undefined,
        dependsOn: values.dependsOn,
        goalId: values.goalId || undefined,
        instructions: values.instructions.trim(),
        maxRepairRounds: values.maxRepairRounds,
        model: isCodingAgent ? undefined : values.model || undefined,
        parentTaskId: values.parentTaskId || undefined,
        skillId: isCodingAgent ? undefined : values.skillId || undefined,
        successCriteria: values.successCriteria.trim() || undefined,
        title: values.title.trim(),
    };
};

/**
 * Tasks a task may depend on or nest under: every other task except its own
 * descendants (nesting under one would loop). Dependency cycles are left to the
 * backend, which names the cycle in its error.
 */
export const selectableRelatives = (tasks: ReadonlyArray<BoardTask>, taskId: Id<"tasks"> | undefined): BoardTask[] => {
    if (!taskId) {
        return [...tasks];
    }

    const descendants = new Set<string>([taskId]);
    let grew = true;

    while (grew) {
        grew = false;

        for (const task of tasks) {
            if (!task.parentTaskId || !descendants.has(task.parentTaskId) || descendants.has(task._id)) {
                continue;
            }

            descendants.add(task._id);
            grew = true;
        }
    }

    return tasks.filter((task) => !descendants.has(task._id));
};

// ─── Schedule presets ────────────────────────────────────────────────────────

export type SchedulePresetKey = "none" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";

/** Presets in the trigger schedule format (5-field, UTC). */
export const SCHEDULE_PRESETS: ReadonlyArray<{ cron: string; key: Exclude<SchedulePresetKey, "custom" | "none"> }> = [
    { cron: "0 * * * *", key: "hourly" },
    { cron: "0 9 * * *", key: "daily" },
    { cron: "0 9 * * 1-5", key: "weekdays" },
    { cron: "0 9 * * 1", key: "weekly" },
];

export const presetForCron = (cron: string): SchedulePresetKey => {
    const trimmed = cron.trim();

    if (!trimmed) {
        return "none";
    }

    return SCHEDULE_PRESETS.find((preset) => preset.cron === trimmed)?.key ?? "custom";
};

// ─── Notifications ───────────────────────────────────────────────────────────

export interface TaskTransition {
    status: "done" | "needs_review";
    taskId: Id<"tasks">;
    title: string;
}

/**
 * Tasks that moved INTO `done` or `needs_review` between two snapshots of the
 * board. The first snapshot (`previous` undefined) announces nothing — a page
 * load is not news — and neither does a task that was already there.
 */
export const findAnnounceableTransitions = (
    previous: ReadonlyMap<string, TaskStatus> | undefined,
    tasks: ReadonlyArray<Pick<BoardTask, "_id" | "status" | "title">>,
): TaskTransition[] => {
    if (!previous) {
        return [];
    }

    return tasks.flatMap((task) => {
        const before = previous.get(task._id);

        if (before === undefined || before === task.status || (task.status !== "done" && task.status !== "needs_review")) {
            return [];
        }

        return [{ status: task.status, taskId: task._id, title: task.title }];
    });
};
