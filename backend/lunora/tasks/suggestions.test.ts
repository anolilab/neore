/**
 * Suggested tasks: off by default, listed only while the switch is on, and never turned into a task without an
 * accept — which creates exactly one task, once, for the owner's pending row. Dismiss, ownership, the server-only
 * insert, the erase and the GDPR export and deletion are pinned here too.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserExportPrefix } from "../browser/export-pages";
import { containsSecret } from "../lib/secret-redaction";
import schema from "../schema";
import {
    readAllTaskSuggestionPages,
    storeAllTaskSuggestionPages,
    TASK_SUGGESTIONS_EXPORT_BYTES,
    TASK_SUGGESTIONS_EXPORT_PAGES,
    taskSuggestionsExportPageKey,
} from "./export-pages";
import { collectTaskSuggestionsForExport, deleteUserTasks, storeTaskSuggestionsExportPage } from "./gdpr";
import { MAX_DECIDED_SUGGESTIONS_PER_STATUS, MAX_PENDING_SUGGESTIONS, TASK_INSTRUCTIONS_MAX, TASK_SCHEDULE_MAX, TASK_TITLE_MAX } from "./logic";
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

type Handler = { handler: (ctx: unknown, args: unknown) => Promise<unknown> };

const RUN = "request-1:instance-1";
const ONE_MIB = 1024 * 1024;

/** What the export workflow does with the suggestions: every page read through the real query, stored as an object, and read back. */
const exportThroughStorage = async (userId: string, { stopped = false }: { stopped?: boolean } = {}) => {
    const objects = new Map<string, string>();
    const results: unknown[] = [];
    const queried: unknown[] = [];
    const prefix = browserExportPrefix(userId, RUN);
    const ctx = {
        runQuery: async (_reference: unknown, args: Record<string, unknown>) => {
            if ("runKey" in args) {
                return stopped;
            }

            const page = await harness.run(async (context: any) => await context.runQuery(collectTaskSuggestionsForExport, args));

            queried.push(page);

            return page;
        },
        storage: {
            delete: async (key: string) => objects.delete(key),
            store: async (key: string, blob: Blob) => {
                objects.set(key, await blob.text());
            },
        },
    };
    const walked = await storeAllTaskSuggestionPages(async (cursor, page) => {
        const result = (await (storeTaskSuggestionsExportPage as unknown as Handler).handler(ctx, {
            ...(cursor !== undefined && { cursor }),
            key: taskSuggestionsExportPageKey(prefix, page),
            runKey: RUN,
            userId,
        })) as { bytes?: number; next?: string };

        results.push(result);

        return result;
    });
    const read = await readAllTaskSuggestionPages(
        async (page) => objects.get(taskSuggestionsExportPageKey(prefix, page))!,
        walked.pages,
        TASK_SUGGESTIONS_EXPORT_BYTES,
        walked.cut,
    );

    return { cut: read.cut, objects, queried, results, rows: read.taskSuggestions as any[] };
};

const exportSuggestions = async (userId: string): Promise<any[]> => {
    const { rows } = await exportThroughStorage(userId);

    return rows;
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

    it("erases an older pending suggestion even when a full batch of newer decided ones sorts ahead of it", async () => {
        await setSwitch(A, true);
        await seedSuggestion(A, { createdAt: 100, status: "pending", title: "Old pending" });

        for (let index = 0; index < 120; index += 1) {
            await seedSuggestion(A, { createdAt: 500 + index, status: index % 2 === 0 ? "accepted" : "dismissed", title: `Newer ${String(index)}` });
        }

        await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserTaskSuggestions, { before: 200, userId: A }));

        const remaining = await rowsOf("taskSuggestions", A);
        const titles = remaining.map((row) => row.title);

        expect(titles).toHaveLength(120);
        expect(titles).not.toContain("Old pending");
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

    it("drops a schedule that matches no date, and one an accept would refuse as too long", async () => {
        await setSwitch(A, true);

        const tooLong = `${Array.from({ length: 60 }, (_, minute) => String(minute)).join(",")} 9 * * 1`;

        expect(tooLong.length).toBeGreaterThan(TASK_SCHEDULE_MAX);
        await expect(
            insert(A, [proposal({ cronExpression: "0 0 30 2 *" }), proposal({ cronExpression: tooLong }), proposal({ title: "Kept" })]),
        ).resolves.toEqual({
            inserted: 1,
        });

        const stored = await rowsOf("taskSuggestions", A);

        expect(stored.map((row) => row.title)).toEqual(["Kept"]);
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

    it("drops a proposal whose secret straddles the length cut, though the part left would pass the filter", async () => {
        await setSwitch(A, true);

        // Built from parts so the repo holds no key-shaped literal. Only "sk-" and 8 body characters fit before the cut.
        const key = ["sk", "-", "12345678", "90abcdefghijklmnopqrstuvwxyz"].join("");
        const instructions = `${"a".repeat(TASK_INSTRUCTIONS_MAX - 11 - 1)} ${key}`;
        const title = `${"b".repeat(TASK_TITLE_MAX - 11 - 1)} ${key}`;

        expect(instructions.length).toBeGreaterThan(TASK_INSTRUCTIONS_MAX);
        expect(containsSecret(instructions.slice(0, TASK_INSTRUCTIONS_MAX))).toBe(false);
        expect(containsSecret(title.slice(0, TASK_TITLE_MAX))).toBe(false);
        await expect(insert(A, [proposal({ instructions }), proposal({ title }), proposal({ title: "Clean" })])).resolves.toEqual({ inserted: 1 });

        expect(await rowsOf("taskSuggestions", A)).toMatchObject([{ title: "Clean" }]);
    });

    it("drops a secret broken up by a zero-width character, which accepting would make whole again", async () => {
        await setSwitch(A, true);

        // Built from parts so the repo holds no key-shaped literal.
        const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
        const split = `${key.slice(0, 6)}\u{200B}${key.slice(6)}`;
        const tagged = `${key.slice(0, 6)}\u{E0041}${key.slice(6)}`;

        await expect(
            insert(A, [proposal({ instructions: `Use the key ${split}` }), proposal({ title: `Key ${tagged}` }), proposal({ title: "Clean" })]),
        ).resolves.toEqual({ inserted: 1 });

        expect(await rowsOf("taskSuggestions", A)).toMatchObject([{ title: "Clean" }]);
    });

    it("drops a title made only of hidden characters, and stores the text as accepting would", async () => {
        await setSwitch(A, true);

        await expect(
            insert(A, [proposal({ title: "​‮\u{E0041}" }), proposal({ instructions: "​ ⁠", title: "No text" }), proposal({ title: "Wee​kly" })]),
        ).resolves.toEqual({ inserted: 1 });

        expect(await rowsOf("taskSuggestions", A)).toMatchObject([{ title: "Weekly" }]);
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

    it("keeps only the newest cap of accepted rows when one more is accepted, and leaves dismissed rows alone", async () => {
        await setSwitch(A, true);

        for (let index = 1; index <= MAX_DECIDED_SUGGESTIONS_PER_STATUS; index += 1) {
            await seedSuggestion(A, { createdAt: index, status: "accepted", title: `Accepted ${String(index)}` });
        }

        await seedSuggestion(A, { createdAt: 500, status: "dismissed", title: "Dismissed" });
        await insert(A, [proposal()]);
        const suggestionId = await pendingId(A);

        await as(A).mutation(acceptTaskSuggestion as never, { suggestionId } as never);

        const rows = await rowsOf("taskSuggestions", A);
        const accepted = rows.filter((row) => row.status === "accepted");

        expect(accepted).toHaveLength(MAX_DECIDED_SUGGESTIONS_PER_STATUS);
        expect(accepted.some((row) => row.title === "Accepted 1")).toBe(false);
        expect(accepted.some((row) => row.title === "Weekly notes")).toBe(true);
        expect(rows.filter((row) => row.status === "dismissed")).toHaveLength(1);
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

    it("keeps only the newest cap of each decided status, and leaves the other status and pending rows alone", async () => {
        const over = MAX_DECIDED_SUGGESTIONS_PER_STATUS + 5;

        await setSwitch(A, true);
        await setSwitch(B, true);

        for (let index = 1; index <= over; index += 1) {
            await seedSuggestion(A, { createdAt: index, status: "pending", title: `Dismiss ${String(index)}` });
            await seedSuggestion(A, { createdAt: index, status: "accepted", title: `Accepted ${String(index)}` });
            await seedSuggestion(B, { createdAt: index, status: "dismissed", title: `Other ${String(index)}` });
        }

        const seeded = await rowsOf("taskSuggestions", A);
        const pendingIds = seeded.filter((row) => row.status === "pending").map((row) => row._id as string);

        for (const suggestionId of pendingIds) {
            await as(A).mutation(dismissTaskSuggestion as never, { suggestionId } as never);
        }

        const rows = await rowsOf("taskSuggestions", A);
        const dismissed = rows.filter((row) => row.status === "dismissed");

        expect(dismissed).toHaveLength(MAX_DECIDED_SUGGESTIONS_PER_STATUS);
        expect(Math.min(...dismissed.map((row) => row.createdAt as number))).toBe(over - MAX_DECIDED_SUGGESTIONS_PER_STATUS + 1);
        expect(rows.filter((row) => row.status === "accepted")).toHaveLength(over);
        expect(rows.filter((row) => row.status === "pending")).toHaveLength(0);
        expect(await rowsOf("taskSuggestions", B)).toHaveLength(over);
    });

    it("holds the cap even when the row dismissed is older than the rows kept", async () => {
        await setSwitch(A, true);
        await seedSuggestion(A, { createdAt: 1, status: "pending", title: "Old idea" });

        for (let index = 2; index <= MAX_DECIDED_SUGGESTIONS_PER_STATUS + 1; index += 1) {
            await seedSuggestion(A, { createdAt: index, status: "dismissed", title: `Dismissed ${String(index)}` });
        }

        const suggestionId = await pendingId(A);

        await as(A).mutation(dismissTaskSuggestion as never, { suggestionId } as never);

        const rows = await rowsOf("taskSuggestions", A);
        const dismissed = rows.filter((row) => row.status === "dismissed");

        expect(dismissed).toHaveLength(MAX_DECIDED_SUGGESTIONS_PER_STATUS);
        expect(dismissed.some((row) => row.title === "Old idea")).toBe(false);
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

        const exported = await exportSuggestions(A);

        expect(exported).toHaveLength(2);
        expect(exported.every((row: { userId: string }) => row.userId === A)).toBe(true);
    });

    it("exports every suggestion past the old 1,000-row cap, across statuses", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1050; index += 1) {
                await ctx.db.insert("taskSuggestions", {
                    createdAt: index,
                    cronExpression: "0 9 * * 1",
                    instructions: "x",
                    sourceThreadIds: [],
                    status: index % 2 === 0 ? "dismissed" : "pending",
                    title: `Idea ${String(index)}`,
                    userId: A,
                });
            }
        });

        expect(await exportSuggestions(A)).toHaveLength(1050);
    });

    it("lists the pending suggestions first, so a history cut for its size loses the oldest decided ones", async () => {
        await seedSuggestion(A, { createdAt: 1, status: "accepted", title: "Accepted" });
        await seedSuggestion(A, { createdAt: 2, status: "dismissed", title: "Dismissed" });
        await seedSuggestion(A, { createdAt: 3, status: "pending", title: "Pending" });

        const rows = await exportSuggestions(A);

        expect(rows.map((row) => row.title)).toStrictEqual(["Pending", "Dismissed", "Accepted"]);
    });

    it("keeps a page of the largest rows under 1 MiB, even when every character is escaped to six bytes", async () => {
        const worst = "\u{1}".repeat(20_000);

        for (let index = 0; index < 20; index += 1) {
            await seedSuggestion(A, { createdAt: index, instructions: worst, title: "\u{1}".repeat(200) });
        }

        const { queried, rows } = await exportThroughStorage(A);

        expect(rows).toHaveLength(20);

        for (const page of queried as { taskSuggestions: unknown[] }[]) {
            expect(page.taskSuggestions.length).toBeLessThanOrEqual(8);
            expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(ONE_MIB);
        }
    });

    it("exports a history of more than 1 MiB whole, through pages that each stay under it", async () => {
        for (let index = 0; index < 100; index += 1) {
            await seedSuggestion(A, { createdAt: index, instructions: "x".repeat(20_000), status: index % 2 === 0 ? "dismissed" : "accepted" });
        }

        const { cut, objects, results, rows } = await exportThroughStorage(A);
        const stored = [...objects.values()].map((text) => new TextEncoder().encode(text).byteLength);

        expect(rows).toHaveLength(100);
        expect(cut).toBe(false);
        // More than a step result or a dispatch body may carry, yet no page is, and no step result carries a row.
        expect(stored.reduce((total, size) => total + size, 0)).toBeGreaterThan(ONE_MIB);
        expect(Math.max(...stored)).toBeLessThan(ONE_MIB);
        expect(JSON.stringify(results).length).toBeLessThan(10_000);
    });

    it("exports a long history of short rows whole: its cut is by bytes, never by a row count", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 2000; index += 1) {
                await ctx.db.insert("taskSuggestions", {
                    createdAt: index,
                    cronExpression: "0 9 * * 1",
                    instructions: "Short",
                    sourceThreadIds: [],
                    status: index % 2 === 0 ? "dismissed" : "accepted",
                    title: `Idea ${String(index)}`,
                    userId: A,
                });
            }
        });

        const { cut, results, rows } = await exportThroughStorage(A);

        expect(rows).toHaveLength(2000);
        expect(new Set(rows.map((row) => row._id)).size).toBe(2000);
        expect(cut).toBe(false);
        // Pages are filled to a byte target, so a short history is a few steps, not one per 8 rows.
        expect(results.length).toBeLessThan(10);
    });

    it("cuts a history that passes its share of the file or its page cap, and says so", async () => {
        const never = async () => {
            return { next: "more" };
        };

        expect(await storeAllTaskSuggestionPages(never)).toStrictEqual({ cut: true, pages: TASK_SUGGESTIONS_EXPORT_PAGES });
        // The page that would pass the share is not counted, and none is stored after it.
        expect(
            await storeAllTaskSuggestionPages(async () => {
                return { bytes: TASK_SUGGESTIONS_EXPORT_BYTES / 2 + 1, next: "more" };
            }),
        ).toStrictEqual({
            cut: true,
            pages: 1,
        });
        expect(
            await storeAllTaskSuggestionPages(async () => {
                return { bytes: 10 };
            }),
        ).toStrictEqual({ cut: false, pages: 1 });
        expect(await readAllTaskSuggestionPages(async () => JSON.stringify({ taskSuggestions: [{ instructions: "x".repeat(100) }] }), 3, 300)).toMatchObject({
            cut: true,
            taskSuggestions: [expect.anything(), expect.anything()],
        });
    });

    it("stores nothing once the export has stopped, and nothing outside the user's own prefix", async () => {
        await seedSuggestion(A, {});

        const stopped = exportThroughStorage(A, { stopped: true });

        await expect(stopped).rejects.toThrow("The export has stopped");

        const ctx = { runQuery: async () => false, storage: { delete: async () => true, store: async () => undefined } };

        await expect(
            (storeTaskSuggestionsExportPage as unknown as Handler).handler(ctx, {
                key: taskSuggestionsExportPageKey(browserExportPrefix(B, RUN), 0),
                runKey: RUN,
                userId: A,
            }),
        ).rejects.toThrow("own export prefix");
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
