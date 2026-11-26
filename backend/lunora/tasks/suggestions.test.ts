/**
 * Suggested tasks: off by default, listed only while the switch is on, and never turned into a task without an
 * accept — which creates exactly one task, once, for the owner's pending row. Dismiss, ownership, the server-only
 * insert, the erase and the GDPR export and deletion are pinned here too.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { collectTasksForExport, deleteUserTasks } from "./gdpr";
import { MAX_PENDING_SUGGESTIONS } from "./logic";
import { acceptTaskSuggestion, dismissTaskSuggestion, eraseUserTaskSuggestions, insertTaskSuggestions, listTaskSuggestions } from "./suggestions";

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

vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

const A = "user-a";
const B = "user-b";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const setSwitch = async (userId: string, enabled: boolean | undefined): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { userId, ...(enabled !== undefined && { scheduleIdeasEnabled: enabled }) });
    });
};

const proposal = (overrides: Record<string, unknown> = {}) => {
    return { cronExpression: "0 9 * * 1", instructions: "Summarise the week's notes", sourceThreadIds: ["thread-1"], title: "Weekly notes", ...overrides };
};

const insert = async (userId: string, suggestions: Record<string, unknown>[]) =>
    await harness.run(async (ctx: any) => await ctx.runMutation(insertTaskSuggestions, { suggestions, userId }));

const rowsOf = async (table: string, userId: string): Promise<any[]> =>
    await harness.run(async (ctx: any) => {
        const rows: { userId: string }[] = await ctx.db.query(table).collect();

        return rows.filter((row) => row.userId === userId);
    });

const firstRow = async (table: string, userId: string): Promise<any> => {
    const [row] = await rowsOf(table, userId);

    return row;
};

const seedSuggestion = async (userId: string, fields: Record<string, unknown>): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("taskSuggestions", {
            createdAt: 1,
            cronExpression: "0 9 * * 1",
            instructions: "x",
            sourceThreadIds: [],
            status: "pending",
            title: "Idea",
            userId,
            ...fields,
        });
    });
};

const pendingId = async (userId: string): Promise<string> => {
    const rows = await rowsOf("taskSuggestions", userId);

    return rows.find((row) => row.status === "pending")!._id;
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
    users.clear();
    users.set(A, {});
    users.set(B, {});
});

afterEach(() => {
    harness.close();
});

describe("the switch", () => {
    it("is off when never set, and when absent from the settings row", async () => {
        await expect(as(A).query(listTaskSuggestions as never, {} as never)).resolves.toEqual([]);

        await setSwitch(A, undefined);
        await expect(insert(A, [proposal()])).resolves.toEqual({ inserted: 0 });
        await expect(as(A).query(listTaskSuggestions as never, {} as never)).resolves.toEqual([]);
        expect(await rowsOf("taskSuggestions", A)).toHaveLength(0);
    });

    it("refuses an accept while it is off, even for a pending row of the caller", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal()]);

        const suggestionId = await pendingId(A);

        await harness.run(async (ctx: any) => {
            const settings = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", settings[0]._id, { scheduleIdeasEnabled: false });
        });

        await expect(as(A).mutation(acceptTaskSuggestion as never, { suggestionId } as never)).rejects.toThrow("turned off");
        expect(await rowsOf("tasks", A)).toHaveLength(0);
    });

    it("erases every suggestion of the user, and only theirs", async () => {
        await setSwitch(A, true);
        await setSwitch(B, true);
        await insert(A, [proposal(), proposal({ title: "Second" })]);
        await insert(B, [proposal()]);
        await as(A).mutation(dismissTaskSuggestion as never, { suggestionId: await pendingId(A) } as never);

        await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserTaskSuggestions, { before: Date.now() + 60_000, userId: A }));

        expect(await rowsOf("taskSuggestions", A)).toHaveLength(0);
        expect(await rowsOf("taskSuggestions", B)).toHaveLength(1);
    });

    it("keeps a suggestion stored after the cutoff, so a late erase cannot remove fresh ones", async () => {
        await setSwitch(A, true);
        await seedSuggestion(A, { createdAt: 100, title: "Before" });
        await seedSuggestion(A, { createdAt: 300, title: "After" });

        await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserTaskSuggestions, { before: 200, userId: A }));

        const rows = await rowsOf("taskSuggestions", A);

        expect(rows.map((row) => row.title)).toEqual(["After"]);
    });
});

describe("listing", () => {
    it("shows the caller's pending suggestions, newest first, without anyone else's or decided ones", async () => {
        await setSwitch(A, true);
        await setSwitch(B, true);
        await seedSuggestion(A, { createdAt: 100, title: "Oldest" });
        await seedSuggestion(A, { createdAt: 300, title: "Newest" });
        await seedSuggestion(A, { createdAt: 200, title: "Middle" });
        await seedSuggestion(A, { createdAt: 400, status: "dismissed", title: "Decided" });
        await seedSuggestion(B, { createdAt: 500, title: "Theirs" });

        const listed = (await as(A).query(listTaskSuggestions as never, {} as never)) as { title: string }[];

        expect(listed.map((row) => row.title)).toEqual(["Newest", "Middle", "Oldest"]);
    });

    it("never lists, or stores, more than the pending ceiling", async () => {
        await setSwitch(A, true);
        await insert(
            A,
            Array.from({ length: MAX_PENDING_SUGGESTIONS + 5 }, (_unused, index) => proposal({ title: `Idea ${String(index)}` })),
        );
        await expect(insert(A, [proposal()])).resolves.toEqual({ inserted: 0 });

        expect(await rowsOf("taskSuggestions", A)).toHaveLength(MAX_PENDING_SUGGESTIONS);
        expect(await as(A).query(listTaskSuggestions as never, {} as never)).toHaveLength(MAX_PENDING_SUGGESTIONS);
    });
});

describe("storing", () => {
    it("drops a proposal with a bad schedule or no text and keeps the rest", async () => {
        await setSwitch(A, true);

        await expect(
            insert(A, [proposal({ cronExpression: "not a cron" }), proposal({ title: "  " }), proposal({ instructions: "" }), proposal({ title: "Kept" })]),
        ).resolves.toEqual({ inserted: 1 });

        const rows = await rowsOf("taskSuggestions", A);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "pending", title: "Kept" });
    });

    it("drops a proposal whose text holds a secret", async () => {
        await setSwitch(A, true);

        await expect(
            insert(A, [
                proposal({ instructions: "Call the API with Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789" }),
                proposal({ title: "Clean" }),
            ]),
        ).resolves.toEqual({ inserted: 1 });

        expect(await rowsOf("taskSuggestions", A)).toMatchObject([{ title: "Clean" }]);
    });

    it("keeps the source chat ids once each, at most five, and no message text", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal({ sourceThreadIds: ["t1", "t1", "t2", "t3", "t4", "t5", "t6"] })]);

        const [row] = await rowsOf("taskSuggestions", A);

        expect(row.sourceThreadIds).toEqual(["t1", "t2", "t3", "t4", "t5"]);
        expect(new Set(Object.keys(row))).toEqual(
            new Set(["_creationTime", "_id", "createdAt", "cronExpression", "instructions", "sourceThreadIds", "status", "title", "userId"]),
        );
    });
});

describe("accepting", () => {
    it("creates exactly one task from the suggestion, then marks it accepted", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal()]);

        const suggestionId = await pendingId(A);
        const { taskId } = (await as(A).mutation(acceptTaskSuggestion as never, { suggestionId } as never)) as { taskId: string };
        const tasks = await rowsOf("tasks", A);

        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            _id: taskId,
            cronExpression: "0 9 * * 1",
            instructions: "Summarise the week's notes",
            recurring: true,
            title: "Weekly notes",
        });

        const [row] = await rowsOf("taskSuggestions", A);

        expect(row).toMatchObject({ status: "accepted", taskId });
        expect(row.decidedAt).toEqual(expect.any(Number));
    });

    it("creates no second task when accepted again, or when dismissed afterwards", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal()]);

        const suggestionId = await pendingId(A);

        await as(A).mutation(acceptTaskSuggestion as never, { suggestionId } as never);
        await expect(as(A).mutation(acceptTaskSuggestion as never, { suggestionId } as never)).rejects.toThrow("already decided");
        await expect(as(A).mutation(dismissTaskSuggestion as never, { suggestionId } as never)).rejects.toThrow("already decided");

        expect(await rowsOf("tasks", A)).toHaveLength(1);
        expect(await firstRow("taskSuggestions", A)).toMatchObject({ status: "accepted" });
    });

    it("creates nothing for a suggestion that is only listed", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal()]);
        await as(A).query(listTaskSuggestions as never, {} as never);

        expect(await rowsOf("tasks", A)).toHaveLength(0);
    });

    it("answers NOT_FOUND for another user's suggestion and creates nothing", async () => {
        await setSwitch(A, true);
        await setSwitch(B, true);
        await insert(A, [proposal()]);

        const suggestionId = await pendingId(A);

        await expect(as(B).mutation(acceptTaskSuggestion as never, { suggestionId } as never)).rejects.toThrow("Suggestion not found");

        expect(await rowsOf("tasks", B)).toHaveLength(0);
        expect(await rowsOf("tasks", A)).toHaveLength(0);
        expect(await firstRow("taskSuggestions", A)).toMatchObject({ status: "pending" });
    });

    it("leaves the suggestion pending when the task cannot be created", async () => {
        users.set(A, { isAnonymous: true });
        await setSwitch(A, true);
        await insert(A, [proposal()]);

        await expect(as(A).mutation(acceptTaskSuggestion as never, { suggestionId: await pendingId(A) } as never)).rejects.toThrow();

        expect(await rowsOf("tasks", A)).toHaveLength(0);
        expect(await firstRow("taskSuggestions", A)).toMatchObject({ status: "pending" });
    });
});

describe("dismissing", () => {
    it("marks the row dismissed and creates no task", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal()]);
        await as(A).mutation(dismissTaskSuggestion as never, { suggestionId: await pendingId(A) } as never);

        expect(await firstRow("taskSuggestions", A)).toMatchObject({ status: "dismissed" });
        expect(await rowsOf("tasks", A)).toHaveLength(0);
        await expect(as(A).query(listTaskSuggestions as never, {} as never)).resolves.toEqual([]);
    });

    it("answers NOT_FOUND for another user's suggestion and leaves it pending", async () => {
        await setSwitch(A, true);
        await insert(A, [proposal()]);

        await expect(as(B).mutation(dismissTaskSuggestion as never, { suggestionId: await pendingId(A) } as never)).rejects.toThrow("Suggestion not found");

        expect(await firstRow("taskSuggestions", A)).toMatchObject({ status: "pending" });
    });
});

describe("GDPR", () => {
    it("exports the user's suggestions, every status, and nobody else's", async () => {
        await setSwitch(A, true);
        await setSwitch(B, true);
        await insert(A, [proposal(), proposal({ title: "Second" })]);
        await insert(B, [proposal()]);
        await as(A).mutation(dismissTaskSuggestion as never, { suggestionId: await pendingId(A) } as never);

        const exported = await harness.run(async (ctx: any) => await ctx.runQuery(collectTasksForExport, { userId: A }));

        expect(exported.taskSuggestions).toHaveLength(2);
        expect(exported.taskSuggestions.every((row: { userId: string }) => row.userId === A)).toBe(true);
    });

    it("deletes the user's suggestions with their tasks, past one batch, and nobody else's", async () => {
        await setSwitch(A, true);
        await setSwitch(B, true);
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 130; index += 1) {
                await ctx.db.insert("taskSuggestions", {
                    createdAt: index,
                    cronExpression: "0 9 * * 1",
                    instructions: "x",
                    sourceThreadIds: [],
                    status: "pending",
                    title: `Idea ${String(index)}`,
                    userId: A,
                });
            }
        });
        await insert(B, [proposal()]);

        for (let rounds = 0; rounds < 10; rounds += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserTasks, { userId: A }));

            if (!hasMore) {
                break;
            }
        }

        expect(await rowsOf("taskSuggestions", A)).toHaveLength(0);
        expect(await rowsOf("taskSuggestions", B)).toHaveLength(1);
    });
});
