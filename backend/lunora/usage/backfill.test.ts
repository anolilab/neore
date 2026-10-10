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
import { DEFAULT_SKILL_KEY, TOTAL_SKILL_KEY } from "./activity-logic";
import { BACKFILL_ROWS_PER_STEP, getUsageBackfillStatus, REPLY_KEY_KEEP_MS, runUsageBackfillStep, startUsageBackfill, sweepUsageRollup } from "./backfill";

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
const insertThread = async (at: number, orders: RowSpec[][], threadStatus = "active"): Promise<{ rowIds: string[][]; threadId: string }> => {
    vi.setSystemTime(at);

    return await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: threadStatus, title: "T", userId: USER });
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

const status = async () => await harness.withIdentity({ userId: USER } as never).query(getUsageBackfillStatus as never, {} as never);

const state = async () => await harness.run(async (ctx: any) => await ctx.db.usageBackfill.findFirst({ where: { userId: USER } }));

const step = async (runId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(runUsageBackfillStep, { runId, userId: USER }));

/** Steps until done; returns how many it took. `repeat` delivers every step twice, as a redelivering queue would. */
const drain = async (repeat = false): Promise<number> => {
    let steps = 0;

    for (;;) {
        const current = await state();

        if (current.status === "done") {
            return steps;
        }

        await step(current.runId);

        if (repeat) {
            await step(current.runId);
        }

        steps += 1;

        if (steps > 100) {
            throw new Error("backfill did not finish");
        }
    }
};

const rollup = async () =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.usageDaily.findMany({ where: { userId: USER } });

        return (page as { costMicrodollars: number; date: string; replies: number; skillKey: string; skillName?: string; tokens: number }[])
            .map(({ costMicrodollars, date, replies, skillKey, skillName, tokens }) => {
                return { costMicrodollars, date, replies, skillKey, tokens, ...(skillName !== undefined && { skillName }) };
            })
            .toSorted((a, b) => a.date.localeCompare(b.date) || a.skillKey.localeCompare(b.skillKey));
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

        expect(await status()).toBe("idle");
        expect(await start()).toBe("running");

        await drain();

        expect(await rollup()).toStrictEqual(EXPECTED);
        expect(await status()).toBe("done");
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
            await ctx.db.patch(threadId, patch);
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
                await ctx.db.delete(row._id);
            }

            await ctx.db.delete(current);
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
