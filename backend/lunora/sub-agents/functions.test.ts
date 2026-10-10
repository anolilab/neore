/**
 * Sub-agent admission and the run's state machine, driven against the real
 * schema: the depth and fan-out caps, who may delegate, the quota charge, the
 * single claim a redelivered job cannot repeat, and the one post-back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import type { CreateSubAgentRunArgs } from "./functions";
import { admitSubAgentRun, claimQueuedRun, finishRun, linkChildThread, postRunResult } from "./functions";
import { SUB_AGENT_MAX_CONCURRENT, SUB_AGENT_MAX_PER_RUN, SUB_AGENT_POST_MAX_ATTEMPTS } from "./logic";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let userId: string;
let threadId: string;
let admitted: string[];

const insertUser = async (fields: Record<string, unknown> = {}) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", {
                createdAt: 0,
                email: `u${String(Math.random())}@example.com`,
                emailVerified: true,
                name: "U",
                updatedAt: 0,
                ...fields,
            }),
    );

const insertThread = async (owner: string) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: owner }))) as string;

/** Admission plus the insert `createRun` does with its result (the job and reaper need a queue). */
const admit = async (overrides: Partial<CreateSubAgentRunArgs> = {}) =>
    await harness.run(async (ctx: any) => {
        const result = await admitSubAgentRun(ctx, {
            parentThreadId: threadId,
            task: "Research the topic",
            toolCallId: `call-${String(admitted.length)}`,
            userId,
            ...overrides,
        });

        if ("error" in result) {
            return result;
        }

        const runId = await ctx.db.insert("subAgentRuns", result.row);

        admitted.push(runId);

        return { runId };
    });

const runs = async () => await harness.run(async (ctx: any) => await ctx.db.query("subAgentRuns").collect());

const firstRun = async () => {
    const [run] = await runs();

    return run;
};

const NEEDS_ACCOUNT = /need an account/u;
const ONLY_OWNER = /Only the owner/u;
const FAN_OUT_CAP = /At most 3 sub-agents/u;
const DEPTH_CAP = /at most 2 levels/u;
const PER_RUN_CAP = /at most 5 sub-agents of its own/u;

const messagesIn = async (id: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", id))
                .collect(),
    );

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    admitted = [];
    userId = (await insertUser()) as string;
    threadId = await insertThread(userId);
});

afterEach(() => {
    harness.close();
});

describe("admitSubAgentRun", () => {
    it("admits a queued depth-1 run", async () => {
        const result = await admit();

        expect(result).toHaveProperty("runId");

        const [run] = await runs();

        expect(run).toMatchObject({ depth: 1, parentThreadId: threadId, status: "queued", task: "Research the topic", userId });
        expect(admitted).toStrictEqual([run._id]);
    });

    it("refuses an anonymous account", async () => {
        userId = (await insertUser({ isAnonymous: true })) as string;
        threadId = await insertThread(userId);

        expect(await admit()).toStrictEqual({ error: expect.stringMatching(NEEDS_ACCOUNT) });
        expect(admitted).toHaveLength(0);
    });

    it("refuses a thread the caller does not own", async () => {
        const stranger = (await insertUser()) as string;

        expect(await admit({ userId: stranger })).toStrictEqual({ error: expect.stringMatching(ONLY_OWNER) });
        expect(await runs()).toHaveLength(0);
    });

    it(`caps concurrent children at ${String(SUB_AGENT_MAX_CONCURRENT)} and frees a slot when one ends`, async () => {
        for (let index = 0; index < SUB_AGENT_MAX_CONCURRENT; index += 1) {
            expect(await admit()).toHaveProperty("runId");
        }

        expect(await admit()).toStrictEqual({ error: expect.stringMatching(FAN_OUT_CAP) });

        const [first] = await runs();

        await harness.run(async (ctx: any) => await finishRun(ctx, first._id, { kind: "succeeded", result: "done" }));

        expect(await admit()).toHaveProperty("runId");
    });

    it("nests to depth 2 and refuses depth 3", async () => {
        await admit();

        const [level1] = await runs();
        const child1 = await insertThread(userId);

        await harness.run(async (ctx: any) => await ctx.db.patch(level1._id, { childThreadId: child1 }));

        expect(await admit({ parentThreadId: child1 })).toHaveProperty("runId");

        const all: { _id: string; depth: number }[] = await runs();
        const level2 = all.find((run) => run.depth === 2)!;
        const child2 = await insertThread(userId);

        await harness.run(async (ctx: any) => await ctx.db.patch(level2._id, { childThreadId: child2 }));

        expect(await admit({ parentThreadId: child2 })).toStrictEqual({ error: expect.stringMatching(DEPTH_CAP) });
    });

    it(`lets one sub-agent run start at most ${String(SUB_AGENT_MAX_PER_RUN)} children over its life, finished ones included`, async () => {
        await admit();

        const [level1] = await runs();
        const child1 = await insertThread(userId);

        await harness.run(async (ctx: any) => await ctx.db.patch(level1._id, { childThreadId: child1 }));

        // Back to back, each finished before the next — the concurrency cap never trips.
        for (let index = 0; index < SUB_AGENT_MAX_PER_RUN; index += 1) {
            const started = await admit({ parentThreadId: child1 });

            expect(started).toHaveProperty("runId");
            await harness.run(async (ctx: any) => await ctx.db.patch((started as { runId: string }).runId, { status: "succeeded" }));
        }

        expect(await admit({ parentThreadId: child1 })).toStrictEqual({ error: expect.stringMatching(PER_RUN_CAP) });
    });

    it("does not cap the total under a user's own thread (control)", async () => {
        for (let index = 0; index <= SUB_AGENT_MAX_PER_RUN; index += 1) {
            const started = await admit();

            expect(started).toHaveProperty("runId");
            await harness.run(async (ctx: any) => await ctx.db.patch((started as { runId: string }).runId, { status: "succeeded" }));
        }
    });

    it("charges the chat and task daily quotas once per start", async () => {
        await admit();

        const charged = await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect());
        const keys: string[] = charged.map((row: { key: string }) => decodeURIComponent(row.key));

        for (const family of ["chat/dailyText:free", "tasks/dailyRuns:free", "subAgents/run:free"]) {
            expect(
                keys.some((key) => key.includes(family)),
                `${family} in ${keys.join(", ")}`,
            ).toBe(true);
        }
    });

    it("rejects an empty task and an invalid allowlist without charging", async () => {
        expect(await admit({ task: " ".repeat(3) })).toHaveProperty("error");
        expect(await admit({ toolAllowlist: ["not a tool"] })).toHaveProperty("error");
        expect(await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect())).toHaveLength(0);
    });
});

describe("claimQueuedRun", () => {
    it("claims a queued run once; a redelivered job gets nothing", async () => {
        await admit();

        const [run] = await runs();

        expect(await harness.run(async (ctx: any) => await claimQueuedRun(ctx, run._id))).toMatchObject({ _id: run._id });
        expect(await harness.run(async (ctx: any) => await claimQueuedRun(ctx, run._id))).toBeNull();
        expect(await firstRun()).toMatchObject({ status: "running" });
    });
});

describe("linkChildThread", () => {
    it("records the child thread and links it under the parent, once", async () => {
        await admit();

        const [run] = await runs();
        const child = await insertThread(userId);

        expect(await harness.run(async (ctx: any) => await linkChildThread(ctx, run._id, child))).toBe(true);
        expect(await harness.run(async (ctx: any) => await linkChildThread(ctx, run._id, child))).toBe(false);

        const relationships = await harness.run(async (ctx: any) => await ctx.db.query("threadRelationships").collect());

        expect(relationships).toHaveLength(1);
        expect(relationships[0]).toMatchObject({ branchType: "subagent", parentThreadId: threadId, threadId: child, userId });
        expect(await firstRun()).toMatchObject({ childThreadId: child });
    });
});

describe("finishRun", () => {
    it("posts the result to the parent thread once, however often it is called", async () => {
        await admit();

        const [run] = await runs();

        expect(await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "succeeded", result: "The answer is 42." }))).toBe(true);
        // A redelivered completion, or the reaper firing after the run ended.
        expect(await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { error: "late", kind: "failed" }))).toBe(false);

        const posted = await messagesIn(threadId);

        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ agentName: "Sub-agent", message: { role: "assistant" } });
        expect(posted[0].message.content).toContain("The answer is 42.");

        const [ended] = await runs();

        expect(ended).toMatchObject({ result: "The answer is 42.", status: "succeeded" });

        const notifications = await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({ link: `/chat/${threadId}`, outcome: "success", type: "sub_agent", userId });
    });

    it("does not post into a thread that was deleted meanwhile", async () => {
        await admit();

        const [run] = await runs();

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true }));
        await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { error: "boom", kind: "failed" }));

        expect(await messagesIn(threadId)).toHaveLength(0);
        expect(await firstRun()).toMatchObject({ error: "boom", status: "failed" });
    });

    describe("while the parent thread is still streaming", () => {
        const insertStream = async (status: string) =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("persistentStreams", {
                        expiresAt: Date.now() + 60_000,
                        messageId: "m",
                        status,
                        streamingConfig: { contentType: "text", model: "m" },
                        threadId,
                        userId,
                    }),
            );

        it("ends the run at once but holds the post until the stream is done, then posts once", async () => {
            await admit();

            const [run] = await runs();
            const streamId = await insertStream("streaming");

            expect(await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "succeeded", result: "Held." }))).toBe(true);
            expect(await messagesIn(threadId)).toHaveLength(0);
            // The fan-out slot is free although the post is still pending.
            expect(await firstRun()).toMatchObject({ status: "succeeded" });
            expect(await firstRun()).not.toHaveProperty("resultPostedAt");

            // A re-check while it still streams posts nothing.
            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 1))).toBe(false);

            await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "completed" }));

            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 2))).toBe(true);
            // A duplicate re-check, e.g. one scheduled before the post landed.
            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 3))).toBe(false);

            const posted = await messagesIn(threadId);

            expect(posted).toHaveLength(1);
            expect(posted[0].message.content).toContain("Held.");
        });

        it("posts anyway once the waits are used up", async () => {
            await admit();

            const [run] = await runs();

            await insertStream("pending");
            await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { error: "boom", kind: "failed" }));

            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, SUB_AGENT_POST_MAX_ATTEMPTS))).toBe(true);
            expect(await messagesIn(threadId)).toHaveLength(1);
        });
    });
});
