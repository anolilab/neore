/**
 * Sub-agent admission and the run's state machine, driven against the real
 * schema: the depth and fan-out caps, who may delegate, the quota charge, the
 * single claim a redelivered job cannot repeat, and the one post-back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { pruneSubAgentRunsBefore } from "./gdpr";
import type { CreateSubAgentRunArgs } from "./functions";
import {
    admitSubAgentRun,
    cancelOwnedSubAgentRun,
    cancelSubAgentRunsForStop,
    claimQueuedRun,
    finishRun,
    linkChildThread,
    postRunResult,
    runShouldStop,
} from "./functions";
import { SUB_AGENT_MAX_CONCURRENT, SUB_AGENT_MAX_PER_RUN, SUB_AGENT_POST_FAILURE_MAX_ATTEMPTS, SUB_AGENT_POST_MAX_ATTEMPTS, stopWhenRequested } from "./logic";

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
const GONE_PARENT = /is gone/u;
const LOCKED_PARENT = /is locked/u;

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

    it("marks the child thread running while the run is active, and active again when it ends", async () => {
        await admit();

        const [run] = await runs();
        const child = await insertThread(userId);
        const statusOf = async () => {
            const row = await harness.run(async (ctx: any) => await ctx.db.get(child));

            return row.status;
        };

        await harness.run(async (ctx: any) => await linkChildThread(ctx, run._id, child));
        expect(await statusOf()).toBe("running");

        await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "cancelled" }));
        expect(await statusOf()).toBe("active");
    });

    it("keeps the child thread running when a chat reply is streaming there as the run ends", async () => {
        await admit();

        const [run] = await runs();
        const child = await insertThread(userId);

        await harness.run(async (ctx: any) => await linkChildThread(ctx, run._id, child));
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "m",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId: child,
                    userId,
                }),
        );
        await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "cancelled" }));

        const row = await harness.run(async (ctx: any) => await ctx.db.get(child));

        expect(row.status).toBe("running");
    });

    it("refuses a run that was cancelled first, so the caller can drop the new thread", async () => {
        await admit();

        const [run] = await runs();
        const child = await insertThread(userId);

        await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "cancelled" }));

        expect(await harness.run(async (ctx: any) => await linkChildThread(ctx, run._id, child))).toBe(false);
        expect(await firstRun()).not.toHaveProperty("childThreadId");
    });
});

describe("pruneSubAgentRunsBefore", () => {
    it("purges cancelled runs with the other finished ones, and leaves active runs", async () => {
        await admit();
        await admit();
        await admit();

        const [first, second] = await runs();

        await harness.run(async (ctx: any) => await finishRun(ctx, first._id, { kind: "cancelled" }));
        await harness.run(async (ctx: any) => await finishRun(ctx, second._id, { error: "x", kind: "failed" }));

        const deleted = await harness.run(async (ctx: any) => await pruneSubAgentRunsBefore(ctx, Date.now() + 1000, 10));

        expect(deleted).toBe(2);
        expect(await runs()).toHaveLength(1);
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

    describe("when the parent cannot take the post", () => {
        const postJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("postResult") === true);

        it("ends in postFailed at once for a deleted thread, which will not come back", async () => {
            await admit();

            const [run] = await runs();

            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true }));
            await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { error: "boom", kind: "failed" }));

            expect(await messagesIn(threadId)).toHaveLength(0);

            const ended = await firstRun();

            expect(ended).toMatchObject({ error: "boom", status: "failed" });
            expect(ended).not.toHaveProperty("resultPostedAt");
            expect(ended).toMatchObject({ postFailed: expect.stringMatching(GONE_PARENT) });
            expect(postJobs()).toHaveLength(0);
        });

        it("posts a retry that finds the parent unlocked, and a run is not posted twice", async () => {
            await admit();

            const [run] = await runs();

            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: Date.now() }));
            await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "succeeded", result: "Held." }));

            expect(await messagesIn(threadId)).toHaveLength(0);
            expect(await firstRun()).not.toHaveProperty("resultPostedAt");

            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: null }));

            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 0, 1))).toBe(true);
            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 0, 1))).toBe(false);
            expect(await messagesIn(threadId)).toHaveLength(1);
            expect(await firstRun()).toHaveProperty("resultPostedAt");
        });

        it("ends in postFailed after the bound, with a locked parent, and posts nothing", async () => {
            await admit();

            const [run] = await runs();

            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: Date.now() }));
            await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "succeeded", result: "Held." }));

            const before = postJobs().length;

            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 0, SUB_AGENT_POST_FAILURE_MAX_ATTEMPTS - 1))).toBe(false);

            const ended = await firstRun();

            expect(ended).toMatchObject({ postFailed: expect.stringMatching(LOCKED_PARENT) });
            expect(ended).not.toHaveProperty("resultPostedAt");
            expect(postJobs()).toHaveLength(before);
            expect(await messagesIn(threadId)).toHaveLength(0);

            // Terminal: unlocking later does not revive it.
            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: null }));
            expect(await harness.run(async (ctx: any) => await postRunResult(ctx, run._id, 0))).toBe(false);
            expect(await messagesIn(threadId)).toHaveLength(0);
        });
    });

    describe("a worker's runs", () => {
        const insertWorkerRun = async (fields: Record<string, unknown>) =>
            await harness.run(async (ctx: any) => {
                const childThreadId = await ctx.db.insert("threads", { status: "active", title: "Worker", userId });

                return await ctx.db.insert("subAgentRuns", {
                    childThreadId,
                    createdAt: 1,
                    depth: 1,
                    mode: "worker",
                    parentThreadId: threadId,
                    status: "running",
                    task: "Do it",
                    updatedAt: 1,
                    userId,
                    ...fields,
                });
            });

        it("posts a lead-dispatched run back, once", async () => {
            const runId = await insertWorkerRun({ toolCallId: "call-1" });

            await harness.run(async (ctx: any) => await finishRun(ctx, runId, { kind: "succeeded", result: "Done." }));
            await harness.run(async (ctx: any) => await postRunResult(ctx, runId, 0));

            const posted = await messagesIn(threadId);

            expect(posted).toHaveLength(1);
            expect(posted[0].message.content).toContain("Done.");
        });

        it("posts nothing to the lead for a run the user typed, and links its notification to the worker", async () => {
            const runId = await insertWorkerRun({ clientId: "client-1" });

            await harness.run(async (ctx: any) => await finishRun(ctx, runId, { kind: "succeeded", result: "Done." }));
            await harness.run(async (ctx: any) => await postRunResult(ctx, runId, 0));

            const [run] = await runs();
            const [notification] = await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

            expect(await messagesIn(threadId)).toHaveLength(0);
            expect(run).toMatchObject({ status: "succeeded" });
            expect(run).not.toHaveProperty("resultPostedAt");
            expect(run).not.toHaveProperty("postFailed");
            expect(notification.link).toBe(`/chat/${run.childThreadId as string}`);
        });
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

        it("records a gone parent at once instead of waiting out a stream it left behind", async () => {
            await admit();

            const [run] = await runs();

            await insertStream("streaming");
            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true }));
            await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "succeeded", result: "Lost." }));

            expect(await messagesIn(threadId)).toHaveLength(0);
            expect(await firstRun()).toMatchObject({ postFailed: expect.stringMatching(GONE_PARENT), status: "succeeded" });
            expect(harness.scheduler.list().filter((job) => job.functionPath?.includes("postResult") === true)).toHaveLength(0);
        });

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

const NOT_FOUND = /Run not found/u;

describe("cancelling a run", () => {
    const cancel = async (runId: string, caller: string = userId) =>
        await harness.run(async (ctx: any) => await cancelOwnedSubAgentRun(ctx, runId as never, caller));

    it("cancels a queued run: its slot is free, it is never claimed, and the parent hears it never started", async () => {
        await admit();

        const [run] = await runs();

        expect(await cancel(run._id)).toBe(true);
        expect(await firstRun()).toMatchObject({ status: "cancelled" });
        expect(await harness.run(async (ctx: any) => await claimQueuedRun(ctx, run._id))).toBeNull();

        const posted = await messagesIn(threadId);

        expect(posted).toHaveLength(1);
        expect(posted[0].message.content).toContain("**Sub-agent stopped:**");
        expect(posted[0].message.content).toContain("before it started");

        // The slot is free again.
        for (let index = 0; index < SUB_AGENT_MAX_CONCURRENT; index += 1) {
            expect(await admit()).toHaveProperty("runId");
        }
    });

    it("cancels a running run between steps: the loop sees it, a late success cannot overwrite it, one post says the step was billed", async () => {
        await admit();

        const [run] = await runs();

        await harness.run(async (ctx: any) => await claimQueuedRun(ctx, run._id));

        const stop = stopWhenRequested(async () => await harness.run(async (ctx: any) => await runShouldStop(ctx, run._id)));
        const step = { finishReason: "tool-calls" } as never;

        expect(await stop({ steps: [step] })).toBe(false);

        await cancel(run._id);

        // The same step count answers the same (the agent asks twice per step); the next step sees the cancel.
        expect(await stop({ steps: [step] })).toBe(false);
        expect(await stop({ steps: [step, step] })).toBe(true);

        // The child's own report arrives after the cancel and changes nothing.
        expect(await harness.run(async (ctx: any) => await finishRun(ctx, run._id, { kind: "succeeded", result: "late" }))).toBe(false);
        expect(await firstRun()).toMatchObject({ status: "cancelled" });
        expect(await firstRun()).not.toHaveProperty("result");

        const posted = await messagesIn(threadId);

        expect(posted).toHaveLength(1);
        expect(posted[0].message.content).toContain("still ran to its end and was billed");
    });

    it("a second cancel is a no-op", async () => {
        await admit();

        const [run] = await runs();

        expect(await cancel(run._id)).toBe(true);
        expect(await cancel(run._id)).toBe(false);
        expect(await messagesIn(threadId)).toHaveLength(1);
    });

    it("refuses anyone but the owner of the parent thread, and says nothing about whether the run exists", async () => {
        await admit();

        const [run] = await runs();
        const stranger = (await insertUser()) as string;

        await expect(cancel(run._id, stranger)).rejects.toThrow(NOT_FOUND);
        expect(await firstRun()).toMatchObject({ status: "queued" });
    });

    describe("a Stop on a thread", () => {
        const forStop = async (target: string, caller: string = userId) =>
            await harness.run(async (ctx: any) => await cancelSubAgentRunsForStop(ctx, target, caller));

        it("cancels the queued and running runs the stopped parent delegated", async () => {
            await admit();
            await admit();
            await admit();

            const [first, second] = await runs();

            await harness.run(async (ctx: any) => await claimQueuedRun(ctx, first._id));
            await harness.run(async (ctx: any) => await finishRun(ctx, second._id, { kind: "succeeded", result: "done" }));

            expect(await forStop(threadId)).toBe(2);

            const all = await runs();
            const statuses = all.map((run: any) => run.status as string).toSorted((a: string, b: string) => a.localeCompare(b));

            expect(statuses).toStrictEqual(["cancelled", "cancelled", "succeeded"]);
        });

        it("cancels only a sub-agent's own run when its own thread is stopped", async () => {
            await admit();

            const [parentRun] = await runs();
            const childThread = await insertThread(userId);

            await harness.run(async (ctx: any) => await ctx.db.patch(parentRun._id, { childThreadId: childThread }));
            await harness.run(async (ctx: any) => await claimQueuedRun(ctx, parentRun._id));
            await harness.run(async (ctx: any) => await admitAndInsert(ctx, childThread));
            // A sibling under the same parent thread.
            await admit();

            expect(await forStop(childThread)).toBe(1);

            const all = await runs();
            const byStatus = all.map((run: any) => [run.parentThreadId === childThread ? "grandchild" : "child", run.status]);

            expect(byStatus).toStrictEqual([
                ["child", "cancelled"],
                ["grandchild", "queued"],
                ["child", "queued"],
            ]);
        });

        it("stops the runs a sub-agent's thread delegated after its own run has ended", async () => {
            await admit();

            const [parentRun] = await runs();
            const childThread = await insertThread(userId);

            await harness.run(async (ctx: any) => await ctx.db.patch(parentRun._id, { childThreadId: childThread }));
            await harness.run(async (ctx: any) => await finishRun(ctx, parentRun._id, { kind: "succeeded", result: "done" }));
            await harness.run(async (ctx: any) => await admitAndInsert(ctx, childThread));

            expect(await forStop(childThread)).toBe(1);

            const allRuns = await runs();
            const grandchild = allRuns.find((run: any) => run.parentThreadId === childThread);

            expect(grandchild).toMatchObject({ status: "cancelled" });
        });

        it("takes down what a stopped parent's sub-agents delegated too", async () => {
            await admit();

            const [parentRun] = await runs();
            const childThread = await insertThread(userId);

            await harness.run(async (ctx: any) => await ctx.db.patch(parentRun._id, { childThreadId: childThread }));
            await harness.run(async (ctx: any) => await claimQueuedRun(ctx, parentRun._id));
            await harness.run(async (ctx: any) => await admitAndInsert(ctx, childThread));

            expect(await forStop(threadId)).toBe(2);

            const all = await runs();

            expect(all.map((run: any) => run.status as string)).toStrictEqual(["cancelled", "cancelled"]);
        });

        it("never reaches another user's runs", async () => {
            await admit();

            const stranger = (await insertUser()) as string;

            expect(await forStop(threadId, stranger)).toBe(0);
            expect(await firstRun()).toMatchObject({ status: "queued" });
        });
    });
});

/** A queued run under `parentThreadId`, inserted past admission (the caps are not under test). */
const admitAndInsert = async (ctx: any, parentThreadId: string) => {
    const result = await admitSubAgentRun(ctx, { parentThreadId, task: "Nested", toolCallId: "nested", userId });

    if ("row" in result) {
        await ctx.db.insert("subAgentRuns", result.row);
    }
};
