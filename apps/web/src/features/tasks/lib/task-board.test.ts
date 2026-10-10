import type { Id } from "@neore/backend/dataModel";
import { describe, expect, it } from "vitest";

import type { BoardTask, TaskStatus } from "./task-board";
import {
    findAnnounceableTransitions,
    getTaskFormDefaults,
    groupByStatus,
    looksLikeCron,
    presetForCron,
    reviewReason,
    selectableRelatives,
    STATUS_ORDER,
    toTaskPayload,
    validateTaskForm,
} from "./task-board";

const task = (id: string, overrides: Partial<BoardTask> = {}): BoardTask => {
    return {
        _id: id as Id<"tasks">,
        attemptCount: 0,
        codingAgent: null,
        createdAt: 1,
        cronExpression: null,
        dependsOn: [],
        goalId: null,
        instructions: "Do it",
        lastError: null,
        lastRunThreadId: null,
        maxRepairRounds: 2,
        model: null,
        nextRunAt: null,
        parentTaskId: null,
        resultSummary: null,
        reviewNote: null,
        skillId: null,
        status: "todo",
        successCriteria: null,
        title: id,
        updatedAt: 1,
        ...overrides,
    };
};

describe(findAnnounceableTransitions, () => {
    it("announces nothing on the first snapshot", () => {
        expect(findAnnounceableTransitions(undefined, [task("a", { status: "done" })])).toStrictEqual([]);
    });

    it("announces a move into done or needs_review, once", () => {
        const previous = new Map<string, TaskStatus>([
            ["a", "running"],
            ["b", "running"],
            ["c", "done"],
            ["d", "queued"],
        ]);
        const next = [task("a", { status: "done" }), task("b", { status: "needs_review" }), task("c", { status: "done" }), task("d", { status: "running" })];

        expect(findAnnounceableTransitions(previous, next)).toStrictEqual([
            { status: "done", taskId: "a", title: "a" },
            { status: "needs_review", taskId: "b", title: "b" },
        ]);
    });

    it("does not announce a task that is new since the last snapshot", () => {
        expect(findAnnounceableTransitions(new Map(), [task("fresh", { status: "done" })])).toStrictEqual([]);
    });
});

describe(groupByStatus, () => {
    it("puts every task in its status column, newest first, with review first in order", () => {
        const groups = groupByStatus([
            task("a", { status: "done", updatedAt: 1 }),
            task("b", { status: "done", updatedAt: 5 }),
            task("c", { status: "needs_review" }),
        ]);

        expect([...groups.keys()]).toStrictEqual([...STATUS_ORDER]);
        expect(STATUS_ORDER[0]).toBe("needs_review");
        expect(groups.get("done")?.map((entry) => entry._id)).toStrictEqual(["b", "a"]);
        expect(groups.get("needs_review")).toHaveLength(1);
    });
});

describe("task form", () => {
    it("requires a title and instructions and checks the schedule shape", () => {
        const values = { ...getTaskFormDefaults(), cronExpression: "every monday" };

        expect(validateTaskForm(values)).toStrictEqual({ cronExpression: "cronInvalid", instructions: "instructionsRequired", title: "titleRequired" });
        expect(validateTaskForm({ ...values, cronExpression: "0 9 * * 1", instructions: "x", title: "y" })).toStrictEqual({});
    });

    it("sends empty optionals as absent", () => {
        const payload = toTaskPayload({ ...getTaskFormDefaults(), instructions: "  Do it  ", title: " T " });

        expect(payload).toStrictEqual({
            codingAgent: undefined,
            cronExpression: undefined,
            dependsOn: [],
            goalId: undefined,
            instructions: "Do it",
            maxRepairRounds: 2,
            model: undefined,
            parentTaskId: undefined,
            skillId: undefined,
            successCriteria: undefined,
            title: "T",
        });
    });

    it("requires a repository for a coding-agent assignee", () => {
        const values = { ...getTaskFormDefaults(), assignee: "claude_code" as const, instructions: "Fix it", title: "T" };

        expect(validateTaskForm(values)).toStrictEqual({ repoUrl: "repoRequired" });
        expect(validateTaskForm({ ...values, repoUrl: "not a repo" })).toStrictEqual({ repoUrl: "repoInvalid" });
        expect(validateTaskForm({ ...values, repoUrl: "anolilab/neore" })).toStrictEqual({});
        expect(validateTaskForm({ ...values, assignee: "chat" })).toStrictEqual({});
    });

    it("sends a coding-agent assignee without skill or model", () => {
        const payload = toTaskPayload({
            ...getTaskFormDefaults(),
            assignee: "codex",
            branch: " ",
            instructions: "Fix it",
            model: "some-model",
            openPr: true,
            repoUrl: " anolilab/neore ",
            skillId: "skill1" as never,
            title: "T",
        });

        expect(payload.codingAgent).toStrictEqual({ agent: "codex", branch: undefined, openPr: true, repoUrl: "anolilab/neore" });
        expect(payload.skillId).toBeUndefined();
        expect(payload.model).toBeUndefined();
    });

    it("recognises schedule presets", () => {
        expect(presetForCron("")).toBe("none");
        expect(presetForCron("0 9 * * 1")).toBe("weekly");
        expect(presetForCron("15 3 * * *")).toBe("custom");
        expect(looksLikeCron("15 3 * * *")).toBe(true);
        expect(looksLikeCron("1-5/2 * * * *")).toBe(false);
    });

    it("never offers a task itself or its descendants as a relative", () => {
        const tasks = [
            task("root"),
            task("child", { parentTaskId: "root" as Id<"tasks"> }),
            task("grandchild", { parentTaskId: "child" as Id<"tasks"> }),
            task("other"),
        ];

        expect(selectableRelatives(tasks, "root" as Id<"tasks">).map((entry) => entry._id)).toStrictEqual(["other"]);
        expect(selectableRelatives(tasks, undefined)).toHaveLength(4);
    });
});

describe(reviewReason, () => {
    it("reads an error run behind a review as an unchecked answer", () => {
        expect(reviewReason([{ status: "error" }, { status: "failed" }])).toBe("unverified");
    });

    it("reads anything else, or no runs yet, as a verifier that did not pass", () => {
        expect(reviewReason([{ status: "failed" }, { status: "error" }])).toBe("not_passed");
        expect(reviewReason([])).toBe("not_passed");
        expect(reviewReason(undefined)).toBe("not_passed");
    });
});
