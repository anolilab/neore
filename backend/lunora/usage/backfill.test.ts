/**
 * The usage backfill against the in-memory harness: a fixture of stored
 * replies walked in bounded steps into totals known up front, counted once
 * against the live path, and safe to repeat or resume.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_COST_METADATA_KEY } from "../agent/message-cost";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import { recordReplyUsage } from "./activity";
import { DEFAULT_SKILL_KEY, PROJECT_SKILL_KEY, TOTAL_SKILL_KEY } from "./activity-logic";
import {
    BACKFILL_ROWS_PER_STEP,
    getUsageBackfillStatus,
    REPLY_KEY_KEEP_MS,
    runUsageBackfillStep,
    runUsageProjectBackfillStep,
    getUsageBackfillStatuses,
    startUsageBackfill,
    sweepUsageRollup,
} from "./backfill";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

const USER = "user-a";
const COLLABORATOR = "user-c";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Noon UTC, so the UTC day key is unambiguous. */
const DAY_1 = Date.UTC(2026, 8, 20, 12);
const DAY_2 = DAY_1 + DAY_MS;
const STARTED = DAY_2 + DAY_MS;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

interface RowSpec {
    cost?: number;
    parentMessageId?: string;
    role: "assistant" | "tool" | "user";
    speaker?: { id: string; name: string };
    status?: string;
    tokens?: number;
    userId?: string;
}

/** Inserts one thread and its rows, each `order` a prompt plus its reply rows, at `at`. */
const insertThread = async (
    at: number,
    orders: RowSpec[][],
    threadStatus = "active",
    projectId?: string,
): Promise<{ rowIds: string[][]; threadId: string }> => {
    vi.setSystemTime(at);

    return await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", {
            status: threadStatus,
            title: "T",
            userId: USER,
            ...(projectId !== undefined && { projectId }),
        });
        const rowIds: string[][] = [];

        for (const [order, rows] of orders.entries()) {
            const ids: string[] = [];

            for (const [stepOrder, spec] of rows.entries()) {
                ids.push(
                    await ctx.db.insert("messages", {
                        message: { content: "x", role: spec.role },
                        order,
                        status: spec.status ?? "success",
                        stepOrder,
                        threadId,
                        tool: spec.role === "tool",
                        userId: spec.userId ?? USER,
                        ...(spec.parentMessageId !== undefined && { parentMessageId: spec.parentMessageId }),
                        ...(spec.speaker && { agentName: spec.speaker.name, speakerSkillId: spec.speaker.id }),
                        ...(spec.tokens !== undefined && { usage: { totalTokens: spec.tokens } }),
                        ...(spec.cost !== undefined && { providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: spec.cost } } }),
                    }),
                );
            }

            rowIds.push(ids);
        }

        return { rowIds, threadId };
    });
};

const prompt = (userId = USER): RowSpec => {
    return { role: "user", userId };
};

const reply = (tokens: number, cost: number, extra: Partial<RowSpec> = {}): RowSpec => {
    return { cost, role: "assistant", tokens, ...extra };
};

const start = async () => await harness.withIdentity({ userId: USER } as never).mutation(startUsageBackfill as never, {} as never);

const status = async () => await harness.withIdentity({ userId: USER } as never).query(getUsageBackfillStatuses as never, {} as never);

/** The first walk's status in the shape pages loaded before the project walk read. */
const firstWalkStatus = async () => await harness.withIdentity({ userId: USER } as never).query(getUsageBackfillStatus as never, {} as never);

const state = async () => await harness.run(async (ctx: any) => await ctx.db.usageBackfill.findFirst({ where: { userId: USER } }));

const step = async (runId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(runUsageBackfillStep, { runId, userId: USER }));

const projectStep = async (runId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(runUsageProjectBackfillStep, { runId, userId: USER }));

/** Steps both walks until done; returns how many steps it took. `repeat` delivers every step twice, as a redelivering queue would. */
const drain = async (repeat = false): Promise<number> => {
    let steps = 0;

    for (;;) {
        const current = await state();

        if (current.status !== "done") {
            await step(current.runId);

            if (repeat) {
                await step(current.runId);
            }
        } else if (current.projects && current.projects.status !== "done") {
            await projectStep(current.projects.runId);

            if (repeat) {
                await projectStep(current.projects.runId);
            }
        } else {
            return steps;
        }

        steps += 1;

        if (steps > 100) {
            throw new Error("backfill did not finish");
        }
    }
};

interface RollupRow {
    costMicrodollars: number;
    date: string;
    projectKey?: string;
    replies: number;
    skillKey: string;
    skillName?: string;
    tokens: number;
}

const rollup = async () =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.usageDaily.findMany({ where: { userId: USER } });

        return (page as RollupRow[])
            .map(({ costMicrodollars, date, projectKey, replies, skillKey, skillName, tokens }) => {
                return {
                    costMicrodollars,
                    date,
                    replies,
                    skillKey,
                    tokens,
                    ...(skillName !== undefined && { skillName }),
                    ...(projectKey !== undefined && { projectKey }),
                };
            })
            .toSorted((a, b) => a.date.localeCompare(b.date) || a.skillKey.localeCompare(b.skillKey) || (a.projectKey ?? "").localeCompare(b.projectKey ?? ""));
    });

/**
 * The fixture, with its totals worked out by hand:
 *
 * DAY_1 thread: a two-row reply (10+5 tokens, 100+50 µ$), a regenerated
 * sibling (7, 70), a tool-approval continuation in its own order (3, 30), a
 * collaborator's turn (not ours), a reply still pending (the live path's).
 * DAY_2 thread: a group chat — two speakers answer one prompt (4/40 and 6/60).
 * → DAY_1: 3 replies, 25 tokens, 250 µ$ (all the assistant); DAY_2: 2 replies,
 *   10 tokens, 100 µ$, one per speaker.
 */
const insertFixture = async () => {
    const day1 = await insertThread(DAY_1, [
        [prompt(), reply(10, 100), { cost: 50, role: "tool", tokens: 5 }],
        [],
        [prompt(COLLABORATOR), reply(99, 990, { userId: COLLABORATOR })],
        [prompt(), reply(1, 1, { status: "pending" })],
    ]);

    // The sibling and the continuation, added to the orders above.
    const continuationId: string = await harness.run(async (ctx: any) => {
        const { threadId } = day1;
        const base = { status: "success", threadId, tool: false, userId: USER };

        await ctx.db.insert("messages", {
            ...base,
            message: { content: "again", role: "assistant" },
            order: 0,
            parentMessageId: day1.rowIds[0]![0],
            providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: 70 } },
            stepOrder: 3,
            usage: { totalTokens: 7 },
        });

        return await ctx.db.insert("messages", {
            ...base,
            message: { content: "continued", role: "assistant" },
            order: 1,
            providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: 30 } },
            stepOrder: 0,
            usage: { totalTokens: 3 },
        });
    });

    await insertThread(DAY_2, [[prompt(), reply(4, 40, { speaker: { id: "sk_a", name: "Alice" } }), reply(6, 60, { speaker: { id: "sk_b", name: "Bob" } })]]);

    return { ...day1, continuationId };
};

const EXPECTED = [
    { costMicrodollars: 250, date: "2026-09-20", replies: 3, skillKey: DEFAULT_SKILL_KEY, tokens: 25 },
    { costMicrodollars: 250, date: "2026-09-20", replies: 3, skillKey: TOTAL_SKILL_KEY, tokens: 25 },
    { costMicrodollars: 100, date: "2026-09-21", replies: 2, skillKey: TOTAL_SKILL_KEY, tokens: 10 },
    { costMicrodollars: 40, date: "2026-09-21", replies: 1, skillKey: "sk_a", skillName: "Alice", tokens: 4 },
    { costMicrodollars: 60, date: "2026-09-21", replies: 1, skillKey: "sk_b", skillName: "Bob", tokens: 6 },
];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("usage backfill", () => {
    it("fills the rollup with the fixture's known totals", async () => {
        await insertFixture();
        vi.setSystemTime(STARTED);

        expect(await status()).toStrictEqual({ projects: "idle", replies: "idle" });
        expect(await start()).toBe("running");

        await drain();

        expect(await rollup()).toStrictEqual(EXPECTED);
        expect(await status()).toStrictEqual({ projects: "done", replies: "done" });
        const finished = await state();

        expect(finished.replies).toBe(5);
    });

    it("counts nothing twice when every step is delivered twice, or the walk is started again", async () => {
        await insertFixture();
        vi.setSystemTime(STARTED);
        await start();
        await drain(true);

        const finished = await state();

        expect(await start()).toBe("done");
        await step(finished.runId);

        expect(await rollup()).toStrictEqual(EXPECTED);
    });

    it("skips a reply the live path already recorded, and the live path skips one the backfill counted", async () => {
        const day1 = await insertFixture();

        vi.setSystemTime(STARTED);

        // The first reply was recorded live, under its first row's id.
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordReplyUsage, {
                    at: STARTED,
                    costMicrodollars: 150,
                    date: "2026-09-20",
                    replyKey: day1.rowIds[0]![1]!,
                    skillKey: DEFAULT_SKILL_KEY,
                    tokens: 15,
                    userId: USER,
                }),
        );
        await start();
        await drain();

        expect(await rollup()).toStrictEqual(EXPECTED);

        // A late live record of a reply the backfill counted adds nothing.
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordReplyUsage, {
                    at: STARTED,
                    costMicrodollars: 30,
                    date: "2026-09-20",
                    replyKey: day1.continuationId,
                    skillKey: DEFAULT_SKILL_KEY,
                    tokens: 3,
                    userId: USER,
                }),
        );

        expect(await rollup()).toStrictEqual(EXPECTED);
    });

    it("leaves replies started after it to the live path", async () => {
        vi.setSystemTime(DAY_1);
        await start();
        await insertThread(DAY_1 + 1000, [[prompt(), reply(10, 100)]]);
        await drain();

        expect(await rollup()).toStrictEqual([]);
    });

    it("walks in bounded steps and resumes where the last one stopped", async () => {
        const replies = BACKFILL_ROWS_PER_STEP;

        await insertThread(
            DAY_1,
            Array.from({ length: replies }, () => [prompt(), reply(1, 10)]),
        );
        vi.setSystemTime(STARTED);
        await start();

        const first = await state();

        await step(first.runId);

        const afterOne = await state();

        // One step reads at most BACKFILL_ROWS_PER_STEP rows: half the thread.
        expect(afterOne.status).toBe("running");
        expect(afterOne.replies).toBeLessThanOrEqual(BACKFILL_ROWS_PER_STEP / 2);
        expect(afterOne.threadId).toBeDefined();

        // A chain that died is taken over once its lease is gone, from the same position.
        vi.setSystemTime(STARTED + 10 * 60 * 1000);
        expect(await start()).toBe("running");

        const resumed = await state();

        expect(resumed.runId).not.toBe(first.runId);
        expect(resumed.replies).toBe(afterOne.replies);

        // The replaced chain's step does nothing.
        await step(first.runId);

        const afterStale = await state();

        expect(afterStale.replies).toBe(afterOne.replies);

        await drain();

        expect(await rollup()).toStrictEqual([
            { costMicrodollars: 10 * replies, date: "2026-09-20", replies, skillKey: DEFAULT_SKILL_KEY, tokens: replies },
            { costMicrodollars: 10 * replies, date: "2026-09-20", replies, skillKey: TOTAL_SKILL_KEY, tokens: replies },
        ]);
    });
});

describe("usage backfill while threads change under it", () => {
    /** More threads than one step starts, so the walk really pages. */
    const THREADS = 30;

    const patchThread = async (threadId: string, patch: Record<string, unknown>) =>
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, patch);
        });

    /** `THREADS` threads of one reply each (1 token, 10 µ$); the first is created with `firstStatus`. */
    const insertThreads = async (firstStatus: string): Promise<string[]> => {
        const ids: string[] = [];

        for (let index = 0; index < THREADS; index += 1) {
            const { threadId } = await insertThread(DAY_1 + index, [[prompt(), reply(1, 10)]], index === 0 ? firstStatus : "active");

            ids.push(threadId);
        }

        return ids;
    };

    const everyReply = [
        { costMicrodollars: 10 * THREADS, date: "2026-09-20", replies: THREADS, skillKey: DEFAULT_SKILL_KEY, tokens: THREADS },
        { costMicrodollars: 10 * THREADS, date: "2026-09-20", replies: THREADS, skillKey: TOTAL_SKILL_KEY, tokens: THREADS },
    ];

    /** Every thread's reply is in the rollup, and counted by the walk, once. */
    const expectEveryReplyOnce = async () => {
        const finished = await state();

        expect(finished.replies).toBe(THREADS);
        expect(await rollup()).toStrictEqual(everyReply);
    };

    /** Starts the walk and takes its first step, which leaves threads unvisited. */
    const startAndStepOnce = async () => {
        vi.setSystemTime(STARTED);
        await start();

        const started = await state();

        await step(started.runId);

        const afterOne = await state();

        expect(afterOne.status).toBe("running");
        expect(afterOne.replies).toBeLessThan(THREADS);
    };

    it.each([
        // The first-created thread sorts after every active one until the patch
        // moves it among them, behind where the walk stands.
        ["un-archived", "archived", { status: "active" }],
        ["restored", "active", { deleted: false }],
        ["back from an error", "error", { status: "active" }],
    ])("counts a thread %s mid-walk", async (_label, firstStatus, patch) => {
        const ids = await insertThreads(firstStatus);

        if (firstStatus === "active" && "deleted" in patch) {
            await patchThread(ids[0]!, { deleted: true, deletedAt: DAY_1 });
        }

        await startAndStepOnce();
        await patchThread(ids[0]!, patch);
        await drain();

        await expectEveryReplyOnce();
    });

    it.each([
        ["archived", { status: "archived" }],
        ["deleted", { deleted: true, deletedAt: STARTED }],
        ["reordered in the sidebar", { order: 5 }],
    ])("counts every thread once when one is %s mid-walk", async (_label, patch) => {
        const ids = await insertThreads("active");

        await startAndStepOnce();

        // One the walk has seen and one it has not.
        await patchThread(ids[0]!, patch);
        await patchThread(ids.at(-1)!, patch);
        await drain();

        await expectEveryReplyOnce();
    });

    it("carries on past a thread removed where the walk stopped", async () => {
        const ids = await insertThreads("active");

        await startAndStepOnce();

        // The step stopped at its thread cap, after the last thread it finished.
        const stopped = await state();

        expect(stopped.threadId).toBeUndefined();

        const current = ids[stopped.replies - 1]!;

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", current))
                .paginate({ cursor: null, numItems: 100 });

            for (const row of page) {
                await ctx.db.delete("messages", row._id);
            }

            await ctx.db.delete("threads", current);
        });
        await drain();

        await expectEveryReplyOnce();
    });
});

describe("sweepUsageRollup", () => {
    const sweep = async () => await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageRollup, {})));

    it("starts the shard user's backfill, then prunes old reply keys once it is done", async () => {
        vi.setSystemTime(STARTED);

        expect(await sweep()).toStrictEqual({ pruned: 0, status: "running" });

        await drain();
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageReplies", { recordedAt: STARTED - REPLY_KEY_KEEP_MS - 1, replyKey: "old", userId: USER });
            await ctx.db.insert("usageReplies", { recordedAt: STARTED, replyKey: "new", userId: USER });
        });

        expect(await sweep()).toStrictEqual({ pruned: 1, status: "done" });

        const keys = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageReplies.findMany({ where: { userId: USER } });

            return page;
        });

        expect(keys.map((key: { replyKey: string }) => key.replyKey)).toStrictEqual(["new"]);
    });
});

describe("project backfill", () => {
    const insertProject = async (title: string): Promise<string> =>
        await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: DAY_1, title, userId: USER }));

    /** The project rows, costliest first. */
    const projectRows = async () => {
        const rows = await rollup();

        return rows.filter((row) => row.skillKey === PROJECT_SKILL_KEY).toSorted((a, b) => b.costMicrodollars - a.costMicrodollars);
    };

    const live = async (replyKey: string, threadId: string, cost: number, tokens: number) =>
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordReplyUsage, {
                    at: STARTED,
                    costMicrodollars: cost,
                    date: "2026-09-20",
                    replyKey,
                    skillKey: DEFAULT_SKILL_KEY,
                    threadId,
                    tokens,
                    userId: USER,
                }),
        );

    /** The state as it was before the project walk existed: the first walk's alone. */
    const forgetProjectWalk = async () =>
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.usageBackfill.findFirst({ where: { userId: USER } });
            const before = Object.fromEntries(Object.entries(row).filter(([key]) => !["_creationTime", "_id", "projects"].includes(key)));

            await ctx.db.delete("usageBackfill", row._id);
            await ctx.db.insert("usageBackfill", before);
        });

    /** Two projects of one reply each, and a reply in no project: 100 + 40 + 7 µ$. */
    const insertProjectFixture = async () => {
        const alpha = await insertProject("Alpha");
        const beta = await insertProject("Beta");
        const inAlpha = await insertThread(DAY_1, [[prompt(), reply(10, 100)]], "active", alpha);
        const inBeta = await insertThread(DAY_1, [[prompt(), reply(4, 40)]], "active", beta);

        await insertThread(DAY_1, [[prompt(), reply(1, 7)]]);

        return { alpha, beta, inAlpha, inBeta };
    };

    const EXPECTED_PROJECTS = (alpha: string, beta: string) => [
        { costMicrodollars: 100, date: "2026-09-20", projectKey: alpha, replies: 1, skillKey: PROJECT_SKILL_KEY, tokens: 10 },
        { costMicrodollars: 40, date: "2026-09-20", projectKey: beta, replies: 1, skillKey: PROJECT_SKILL_KEY, tokens: 4 },
    ];

    it("files replies the rollup already counted under their thread's project, and moves no total", async () => {
        const { alpha, beta } = await insertProjectFixture();

        vi.setSystemTime(STARTED);
        await start();
        await drain();

        expect(await status()).toStrictEqual({ projects: "done", replies: "done" });
        const rows = await rollup();

        expect(await projectRows()).toStrictEqual(EXPECTED_PROJECTS(alpha, beta));
        expect(rows.find((row) => row.skillKey === TOTAL_SKILL_KEY)).toMatchObject({ costMicrodollars: 147, replies: 3 });
    });

    it("is idempotent: every step delivered twice, and a walk started again, file each reply once", async () => {
        const { alpha, beta } = await insertProjectFixture();

        vi.setSystemTime(STARTED);
        await start();
        await drain(true);

        const finished = await state();

        expect(finished.projects.replies).toBe(2);
        expect(await start()).toBe("done");
        await projectStep(finished.projects.runId);
        await drain(true);

        expect(await projectRows()).toStrictEqual(EXPECTED_PROJECTS(alpha, beta));
    });

    it("files a thread moved to another project between steps under the project it was in when the walk began it", async () => {
        const alpha = await insertProject("Alpha");
        const beta = await insertProject("Beta");
        // Twice what one step reads: the walk stops part-way through the thread.
        const long = await insertThread(
            DAY_1,
            Array.from({ length: BACKFILL_ROWS_PER_STEP }, () => [prompt(), reply(1, 10)]),
            "active",
            alpha,
        );

        vi.setSystemTime(STARTED);
        await start();

        for (let current = await state(); current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        const walking = await state();

        await projectStep(walking.projects.runId);

        const stopped = await state();

        expect(stopped.projects.threadId).toBe(long.threadId);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", long.threadId, { projectId: beta });
        });
        await drain();

        expect(await projectRows()).toStrictEqual([
            {
                costMicrodollars: 10 * BACKFILL_ROWS_PER_STEP,
                date: "2026-09-20",
                projectKey: alpha,
                replies: BACKFILL_ROWS_PER_STEP,
                skillKey: PROJECT_SKILL_KEY,
                tokens: BACKFILL_ROWS_PER_STEP,
            },
        ]);
    });

    it("starts the project walk only once the first walk is done, from the first walk's cutoff", async () => {
        const { alpha, beta } = await insertProjectFixture();

        vi.setSystemTime(STARTED);
        await start();

        const walking = await state();

        // While the totals are still being added, no project row can be filed ahead of its reply's total.
        expect(walking.projects).toBeUndefined();

        for (let current = walking; current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        const finished = await state();

        expect(finished.projects).toMatchObject({ startedAt: finished.startedAt, status: "running" });
        await drain();
        expect(await projectRows()).toStrictEqual(EXPECTED_PROJECTS(alpha, beta));
    });

    it("starts for a user whose first walk finished before projects were filed", async () => {
        const { alpha, beta } = await insertProjectFixture();

        vi.setSystemTime(STARTED);
        await start();

        // The first walk ran to its end on its own, as it did before the project walk existed.
        for (let current = await state(); current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        await forgetProjectWalk();

        // The totals are complete; only the project walk has still to run, and the usage page waits on nothing else.
        expect(await status()).toStrictEqual({ projects: "idle", replies: "done" });
        // A page loaded before this change reads the old query, which still answers with the first walk's status alone.
        expect(await firstWalkStatus()).toBe("done");
        expect(await start()).toBe("running");
        await drain();

        expect(await projectRows()).toStrictEqual(EXPECTED_PROJECTS(alpha, beta));
    });

    it("skips a reply the live path filed, and the live path files none the walk already did", async () => {
        const { alpha, beta, inAlpha, inBeta } = await insertProjectFixture();

        vi.setSystemTime(STARTED);

        // Alpha's reply finished before the walk and was recorded live afterwards, with its project.
        await live(inAlpha.rowIds[0]![1]!, inAlpha.threadId, 100, 10);
        await start();
        await drain();

        expect(await projectRows()).toStrictEqual(EXPECTED_PROJECTS(alpha, beta));

        // Beta's reply, filed by the walk, now recorded live by a late delivery: no second project row.
        // Its first-walk key is dropped, so the record gets past the reply check and reaches the project one.
        await harness.run(async (ctx: any) => {
            const key = inBeta.rowIds[0]![1]!;

            const recorded = await ctx.db.usageReplies.findFirst({ where: { replyKey: key, userId: USER } });

            await ctx.db.delete("usageReplies", recorded._id);
        });
        await live(inBeta.rowIds[0]![1]!, inBeta.threadId, 40, 4);

        const rows = await projectRows();

        expect(rows.find((row) => row.projectKey === beta)).toMatchObject({ costMicrodollars: 40, replies: 1 });
    });

    it("files a reply's project when its live record lands after the first walk counted it", async () => {
        const { alpha, inAlpha } = await insertProjectFixture();
        const key = inAlpha.rowIds[0]![1]!;

        vi.setSystemTime(STARTED);

        // The first walk counted the reply (its key, with no project) and the project walk had passed it while it ran.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageReplies", { recordedAt: STARTED, replyKey: key, userId: USER });
        });
        await live(key, inAlpha.threadId, 100, 10);
        await live(key, inAlpha.threadId, 100, 10);

        const rows = await projectRows();
        const all = await rollup();

        expect(rows).toStrictEqual([EXPECTED_PROJECTS(alpha, "")[0]]);
        // The total is the first walk's to write, which this fixture skips: the live record adds no second one.
        expect(all.filter((row) => row.skillKey === TOTAL_SKILL_KEY)).toStrictEqual([]);
    });

    it("files no project for a reply after the first walk's cutoff whose total never landed", async () => {
        vi.setSystemTime(DAY_1);
        await start();

        // The first walk ran to its end; then a reply in a project whose live record was lost.
        for (let current = await state(); current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        const alpha = await insertProject("Alpha");

        await insertThread(DAY_1 + 1000, [[prompt(), reply(10, 100)]], "active", alpha);
        vi.setSystemTime(STARTED);
        await drain();

        expect(await projectRows()).toStrictEqual([]);
    });

    it("leaves a reply after the first walk's cutoff under No project, so projects never exceed the total", async () => {
        vi.setSystemTime(DAY_1);
        await start();

        for (let current = await state(); current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        const alpha = await insertProject("Alpha");

        // Recorded live (or lost) after the first walk began; its key was pruned before the project walk existed.
        await insertThread(DAY_1 + 1000, [[prompt(), reply(10, 100)]], "active", alpha);
        await forgetProjectWalk();
        vi.setSystemTime(DAY_1 + 5 * DAY_MS);
        await start();
        await drain();

        expect(await projectRows()).toStrictEqual([]);
    });

    it("keeps projects plus No project equal to the total after both walks", async () => {
        await insertProjectFixture();
        vi.setSystemTime(STARTED);
        await start();
        await drain(true);

        const rows = await rollup();
        const total = rows.filter((row) => row.skillKey === TOTAL_SKILL_KEY).reduce((sum, row) => sum + row.costMicrodollars, 0);
        const projects = rows.filter((row) => row.skillKey === PROJECT_SKILL_KEY).reduce((sum, row) => sum + row.costMicrodollars, 0);

        // 100 + 40 in projects, 7 in no project.
        expect([total, projects, total - projects]).toStrictEqual([147, 140, 7]);
    });

    it("dates a reply's project row in the zone its total was dated in, after the zone changes", async () => {
        const alpha = await insertProject("Alpha");

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("userSettings", { timezone: "Pacific/Kiritimati", userId: USER });
        });
        // 11:00 UTC on 2026-09-20 is already 2026-09-21 in UTC+14.
        await insertThread(Date.UTC(2026, 8, 20, 11), [[prompt(), reply(1, 10)]], "active", alpha);
        vi.setSystemTime(STARTED);
        await start();

        for (let current = await state(); current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        await harness.run(async (ctx: any) => {
            const settings = await ctx.db.userSettings.findFirst({ where: { userId: USER } });

            await ctx.db.patch("userSettings", settings._id, { timezone: "Pacific/Pago_Pago" });
        });
        await drain();

        const rows = await rollup();
        const totalDay = rows.find((row) => row.skillKey === TOTAL_SKILL_KEY)?.date;
        const projectDay = rows.find((row) => row.skillKey === PROJECT_SKILL_KEY)?.date;

        expect(totalDay).toBe("2026-09-21");
        expect(projectDay).toBe(totalDay);
    });

    it("files a late live record's project on the day the first walk dated its total, for a reply that ran past midnight", async () => {
        const alpha = await insertProject("Alpha");
        // Started at 23:59 UTC on 2026-09-20; its live record lands after midnight, dated 2026-09-21.
        const started = Date.UTC(2026, 8, 20, 23, 59);
        const thread = await insertThread(started, [[prompt(), reply(10, 100)]], "active", alpha);
        const key = thread.rowIds[0]![1]!;

        vi.setSystemTime(STARTED);
        await start();
        await drain();

        // The first walk counted it, dated 2026-09-20. Drop the project walk's filing to stand for a walk that passed it running.
        await harness.run(async (ctx: any) => {
            const marker = await ctx.db.usageReplies.findFirst({ where: { replyKey: `project:${key}`, userId: USER } });
            const { page } = await ctx.db.usageDaily.findMany({ where: { skillKey: PROJECT_SKILL_KEY, userId: USER } });

            await ctx.db.delete("usageReplies", marker._id);

            for (const row of page) {
                await ctx.db.delete("usageDaily", row._id);
            }
        });
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordReplyUsage, {
                    at: STARTED,
                    costMicrodollars: 100,
                    date: "2026-09-21",
                    replyKey: key,
                    skillKey: DEFAULT_SKILL_KEY,
                    startedAt: started,
                    threadId: thread.threadId,
                    tokens: 10,
                    userId: USER,
                }),
        );

        const rows = await rollup();

        expect(rows.find((row) => row.skillKey === TOTAL_SKILL_KEY)?.date).toBe("2026-09-20");
        expect(rows.find((row) => row.skillKey === PROJECT_SKILL_KEY)?.date).toBe("2026-09-20");
    });

    it("records UTC as the first walk's zone when the user has none, so setting one later moves no reply", async () => {
        vi.setSystemTime(STARTED);
        await start();

        const started = await state();

        expect(started.timeZone).toBe("UTC");
    });

    it("leaves a reply that may have still been running when the first walk passed it until its live record lands", async () => {
        const alpha = await insertProject("Alpha");

        // Started two hours before the walks (waiting on an approval, say) and still running as the first walk passed it.
        const thread = await insertThread(STARTED - 2 * 60 * 60 * 1000, [[prompt(), reply(10, 100, { status: "pending" })]], "active", alpha);

        vi.setSystemTime(STARTED);
        await start();

        for (let current = await state(); current.status !== "done"; current = await state()) {
            await step(current.runId);
        }

        // It finished; its live record has not landed (or never will), so the total does not hold it yet.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("messages", thread.rowIds[0]![1]!, { status: "success" });
        });
        await drain();

        expect(await projectRows()).toStrictEqual([]);

        // Its live record lands: the total holds it now, and the record files its project.
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordReplyUsage, {
                    at: STARTED,
                    costMicrodollars: 100,
                    date: "2026-09-22",
                    replyKey: thread.rowIds[0]![1]!,
                    skillKey: DEFAULT_SKILL_KEY,
                    threadId: thread.threadId,
                    tokens: 10,
                    userId: USER,
                }),
        );

        const filed = await projectRows();

        expect(filed.map((row) => row.costMicrodollars)).toStrictEqual([100]);
    });

    it("finalizes a late record's filing, so a later delivery after the thread moves files nothing elsewhere", async () => {
        const alpha = await insertProject("Alpha");
        const beta = await insertProject("Beta");
        const thread = await insertThread(DAY_1, [[prompt(), reply(10, 100)]], "active");
        const key = thread.rowIds[0]![1]!;

        vi.setSystemTime(STARTED);
        await start();
        await drain();

        const late = async () =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordReplyUsage, {
                        at: STARTED,
                        costMicrodollars: 100,
                        date: "2026-09-20",
                        replyKey: key,
                        skillKey: DEFAULT_SKILL_KEY,
                        threadId: thread.threadId,
                        tokens: 10,
                        userId: USER,
                    }),
            );

        // Recorded late while the thread had no project, then redelivered after it moved into one.
        await late();
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", thread.threadId, { projectId: beta });
        });
        await late();

        expect(await projectRows()).toStrictEqual([]);
        expect(alpha).toBeDefined();
    });
});
