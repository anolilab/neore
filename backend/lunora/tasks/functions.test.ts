/**
 * The cost gates on the public task procedures: an anonymous account can
 * neither create nor start a task, a task can only name a model the picker
 * offers (or the user's own endpoint), and recurring tasks are capped per user.
 */
import { lunoraTest } from "@lunora/testing";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { selectableTextModels } from "../skills/builder-logic";
import { ANONYMOUS_TASKS_MESSAGE } from "./account";
import { createTask, runTask, updateTask } from "./functions";
import { MAX_RECURRING_TASKS_PER_USER } from "./logic";

// `user` is a `.global()` (D1) table the in-memory harness cannot write: the
// session comes off the harness identity and the account off this map.
const { sessionFrom, users } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
        users: new Map<string, { isAnonymous?: boolean }>(),
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `projects` is a `.global()` table the harness cannot write: what the caller may read and file into is set here.
const { projectAccess } = vi.hoisted(() => {
    return { projectAccess: new Map<string, "read" | "write">() };
});

vi.mock("../projects/functions", () => {
    return {
        readableProject: async (_ctx: unknown, projectId: string) => (projectAccess.has(projectId) ? { _id: projectId } : null),
        writableProject: async (_ctx: unknown, projectId: string) => (projectAccess.get(projectId) === "write" ? { _id: projectId } : null),
    };
});

vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

const USER = "user-a";
const GUEST = "user-guest";
const PICKABLE = selectableTextModels(MODEL_REGISTRY)[0]!.id;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const definition = (overrides: Record<string, unknown> = {}) => {
    return { dependsOn: [], instructions: "Summarise the news", title: "News", ...overrides };
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
    users.clear();
    users.set(USER, {});
    users.set(GUEST, { isAnonymous: true });
    projectAccess.clear();
});

afterEach(() => {
    harness.close();
});

describe("anonymous accounts", () => {
    it("cannot create a task", async () => {
        await expect(as(GUEST).mutation(createTask as never, definition() as never)).rejects.toThrow(ANONYMOUS_TASKS_MESSAGE);
    });

    it("cannot start one they somehow already own", async () => {
        const taskId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("tasks", {
                    attemptCount: 0,
                    createdAt: 1,
                    dependsOn: [],
                    instructions: "x",
                    maxRepairRounds: 2,
                    recurring: false,
                    status: "todo",
                    title: "x",
                    updatedAt: 1,
                    userId: GUEST,
                }),
        );

        await expect(as(GUEST).mutation(runTask as never, { taskId } as never)).rejects.toThrow(ANONYMOUS_TASKS_MESSAGE);
    });
});

describe("task model", () => {
    it("accepts a model the picker offers and the user's own endpoint", async () => {
        await expect(as(USER).mutation(createTask as never, definition({ model: PICKABLE }) as never)).resolves.toMatchObject({ taskId: expect.any(String) });
        await expect(as(USER).mutation(createTask as never, definition({ model: "custom:provider-1:llama" }) as never)).resolves.toMatchObject({
            taskId: expect.any(String),
        });
    });

    it("refuses any other model string", async () => {
        const listedOnly = MODEL_REGISTRY.find((model) => model.provider === "external");

        for (const model of ["not-a-model", ...(listedOnly ? [listedOnly.id] : [])]) {
            await expect(as(USER).mutation(createTask as never, definition({ model }) as never), model).rejects.toThrow("not available for tasks");
        }
    });
});

describe("hidden characters in a task", () => {
    const stored = async (taskId: string) => await harness.run(async (ctx: any) => await ctx.db.get("tasks", taskId));

    it("stores the instructions, title and success criteria without them", async () => {
        const { taskId } = (await as(USER).mutation(
            createTask as never,
            definition({ instructions: "Summarise\u{E0069}\u{E0067} the news\u{202E}", successCriteria: "Short\u{E0041}", title: "News\u{E0042}" }) as never,
        )) as { taskId: string };

        expect(await stored(taskId)).toMatchObject({ instructions: "Summarise the news", successCriteria: "Short", title: "News" });
    });

    it("refuses instructions that were only hidden characters", async () => {
        await expect(as(USER).mutation(createTask as never, definition({ instructions: "\u{E0069}\u{E0067}" }) as never)).rejects.toThrow(
            "Instructions is required",
        );
    });
});

describe("task projects", () => {
    it("refuse a project the caller can read but not file into, such as a colleague's", async () => {
        projectAccess.set("project-colleague", "read");
        projectAccess.set("project-own", "write");

        await expect(as(USER).mutation(createTask as never, definition({ projectId: "project-colleague" }) as never)).rejects.toThrow(
            "only be filed in your own projects",
        );
        await expect(as(USER).mutation(createTask as never, definition({ projectId: "project-unknown" }) as never)).rejects.toThrow("Project not found");
        await expect(as(USER).mutation(createTask as never, definition({ projectId: "project-own" }) as never)).resolves.toMatchObject({});
    });

    it("drop a project the owner can no longer read when the task is edited, but refuse choosing one", async () => {
        const { taskId } = (await as(USER).mutation(createTask as never, definition() as never)) as { taskId: string };

        // A project that was set while readable and is gone now (deleted, or the owner left its organization).
        await harness.run(async (ctx: any) => await ctx.db.patch("tasks", taskId, { projectId: "project-gone" }));

        await expect(as(USER).mutation(updateTask as never, definition({ projectId: "project-gone", taskId, title: "Renamed" }) as never)).resolves.toBeNull();

        const row: any = await harness.run(async (ctx: any) => await ctx.db.get("tasks", taskId));

        expect(row).toMatchObject({ title: "Renamed" });
        expect(row.projectId).toBeUndefined();

        await expect(as(USER).mutation(updateTask as never, definition({ projectId: "project-other", taskId }) as never)).rejects.toThrow("Project not found");
    });
});

describe("locked chats", () => {
    it("refuse choosing to keep a thread whose chat is locked", async () => {
        const { taskId } = (await as(USER).mutation(createTask as never, definition({ cronExpression: "0 9 * * *" }) as never)) as { taskId: string };
        const thread = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { lockedAt: 1, status: "active", title: "Task: News", userId: USER }),
        );

        await harness.run(async (ctx: any) => await ctx.db.patch("tasks", taskId, { lastRunThreadId: thread }));

        await expect(
            as(USER).mutation(updateTask as never, definition({ cronExpression: "0 9 * * *", runDestination: "continue_thread", taskId }) as never),
        ).rejects.toThrow("is locked");
        await expect(
            as(USER).mutation(updateTask as never, definition({ cronExpression: "0 9 * * *", taskId, title: "Renamed" }) as never),
        ).resolves.toBeNull();
    });
});

describe("coding-agent tasks", () => {
    it("refuse a project or a run destination, which a coding agent cannot use", async () => {
        const codingAgent = { agent: "codex", repoUrl: "anolilab/neore" };

        await expect(as(USER).mutation(createTask as never, definition({ codingAgent, projectId: "project-a" }) as never)).rejects.toThrow(
            "cannot have a project or a run destination",
        );
        await expect(
            as(USER).mutation(createTask as never, definition({ codingAgent, cronExpression: "0 9 * * *", runDestination: "continue_thread" }) as never),
        ).rejects.toThrow("cannot have a project or a run destination");
    });
});

describe("recurring tasks", () => {
    it(`are capped at ${String(MAX_RECURRING_TASKS_PER_USER)} per user, on create and on edit`, async () => {
        for (let index = 0; index < MAX_RECURRING_TASKS_PER_USER; index += 1) {
            await as(USER).mutation(createTask as never, definition({ cronExpression: "0 9 * * *", title: `R${String(index)}` }) as never);
        }

        await expect(as(USER).mutation(createTask as never, definition({ cronExpression: "0 9 * * *" }) as never)).rejects.toThrow("recurring tasks");

        // A one-off still goes through, and cannot be turned into a recurring one.
        const { taskId } = (await as(USER).mutation(createTask as never, definition() as never)) as { taskId: string };

        await expect(as(USER).mutation(updateTask as never, definition({ cronExpression: "0 9 * * *", taskId }) as never)).rejects.toThrow("recurring tasks");

        // Editing one of the recurring ones does not count it against itself.
        const rows: any[] = await harness.run(async (ctx: any) => await ctx.db.query("tasks").collect());
        const recurring = rows.find((task) => task.recurring);

        await expect(as(USER).mutation(updateTask as never, definition({ cronExpression: "0 10 * * *", taskId: recurring._id }) as never)).resolves.toBeNull();
    });

    it("drop a recorded skip once the schedule changes or is removed, and keep it otherwise", async () => {
        const { taskId } = (await as(USER).mutation(createTask as never, definition({ cronExpression: "0 9 * * *" }) as never)) as { taskId: string };
        const markSkipped = async () =>
            await harness.run(async (ctx: any) => await ctx.db.patch("tasks", taskId, { lastSkippedAt: 1000, lastSkipReason: "still_running" }));
        const skipOf = async () => {
            const row: any = await harness.run(async (ctx: any) => await ctx.db.get("tasks", taskId));

            return [row.lastSkippedAt, row.lastSkipReason];
        };

        await markSkipped();
        await as(USER).mutation(updateTask as never, definition({ cronExpression: "0 9 * * *", taskId, title: "Renamed" }) as never);
        expect(await skipOf()).toStrictEqual([1000, "still_running"]);

        await as(USER).mutation(updateTask as never, definition({ cronExpression: "0 10 * * *", taskId }) as never);
        expect(await skipOf()).toStrictEqual([undefined, undefined]);

        await markSkipped();
        await as(USER).mutation(updateTask as never, definition({ taskId }) as never);
        expect(await skipOf()).toStrictEqual([undefined, undefined]);
    });
});
