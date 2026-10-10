/**
 * The jobs queue delivers AT LEAST once. These pin the enqueue shape and the
 * claims that make a redelivered job a no-op: the agent run's stream claim and
 * the coding-agent poll sequence. (Task rounds and eval cases have their own
 * redelivery tests: `tasks/internal.test.ts` "claims a queued round once and
 * refuses a duplicate", `evals/internal.test.ts` "claims the next case once".)
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { internal } from "../_generated/internal";
import { canClaimStreamRun, claimStreamRun } from "../chat/streaming/persistent/library";
import { claimPoll, isCurrentPoll } from "../coding-agents/functions";
import schema from "../schema";
import { env, jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { enqueueJob } from "./job-queue";
import { runInShard } from "./shard-context";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

beforeEach(() => {
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const runInternal = async (reference: unknown, args: Record<string, unknown>): Promise<any> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));

describe("enqueueJob", () => {
    it("sends the function path and its args, like a scheduler job", async () => {
        await enqueueJob(internal.tasks.execute.runTaskRound, { cycle: "c1", origin: "manual", round: 0, taskId: "task1" as never });

        expect(jobsQueueMessages).toStrictEqual([
            { body: { args: { cycle: "c1", origin: "manual", round: 0, taskId: "task1" }, functionPath: "tasks_execute:runTaskRound" } },
        ]);
    });

    it("sends the job to the shard it was enqueued from, unless one is named", async () => {
        await runInShard("user-a", async () => {
            await enqueueJob(internal.tasks.execute.runTaskRound, { cycle: "c1", origin: "manual", round: 0, taskId: "task1" as never });
            await enqueueJob(
                internal.tasks.execute.runTaskRound,
                { cycle: "c2", origin: "manual", round: 0, taskId: "task1" as never },
                { shardKey: "owner-b" },
            );
        });
        // `__root__` is the default already; nothing to name.
        await runInShard("__root__", async () => {
            await enqueueJob(internal.tasks.execute.runTaskRound, { cycle: "c3", origin: "manual", round: 0, taskId: "task1" as never });
        });

        expect(jobsQueueMessages.map((message) => message.body.shardKey)).toStrictEqual(["user-a", "owner-b", undefined]);
    });

    it("delays in whole seconds, rounding up, and sends no delay for zero", async () => {
        await enqueueJob(internal.coding_agents.execute.pollCodingAgentRun, { runId: "r" as never, seq: 1 }, { delayMs: 4000 });
        await enqueueJob(internal.coding_agents.execute.pollCodingAgentRun, { runId: "r" as never, seq: 2 }, { delayMs: 1200 });
        await enqueueJob(internal.coding_agents.execute.pollCodingAgentRun, { runId: "r" as never, seq: 3 }, { delayMs: 0 });

        expect(jobsQueueMessages.map((message) => message.delaySeconds)).toStrictEqual([4, 2, undefined]);
    });

    it("fails loudly without the binding instead of dropping the job", async () => {
        const queue = env.QUEUE_JOBS;

        try {
            (env as { QUEUE_JOBS?: unknown }).QUEUE_JOBS = undefined;

            await expect(enqueueJob(internal.tasks.execute.runTaskRound, { cycle: "c", origin: "manual", round: 0, taskId: "t" as never })).rejects.toThrow(
                'no queue named "jobs"',
            );
        } finally {
            env.QUEUE_JOBS = queue;
        }
    });
});

describe("agent run redelivery: the stream claim", () => {
    const insertStream = async (overrides: Record<string, unknown> = {}): Promise<string> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "m1",
                    status: "pending",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId: "t1",
                    userId: "u1",
                    ...overrides,
                }),
        );

    it("lets exactly one delivery generate into a stream", async () => {
        const streamId = await insertStream();

        expect(await runInternal(claimStreamRun, { streamId })).toBe(true);
        // The redelivered message, possibly while the first is still generating.
        expect(await runInternal(claimStreamRun, { streamId })).toBe(false);
        expect(await runInternal(claimStreamRun, { streamId })).toBe(false);
    });

    it("refuses a stream that already finished, timed out, or is gone", async () => {
        expect(await runInternal(claimStreamRun, { streamId: await insertStream({ status: "done" }) })).toBe(false);
        expect(await runInternal(claimStreamRun, { streamId: await insertStream({ status: "timeout" }) })).toBe(false);
        expect(canClaimStreamRun(null)).toBe(false);
    });

    it("allows the claim on a stream that started streaming before being claimed", () => {
        expect(canClaimStreamRun({ status: "streaming" })).toBe(true);
        expect(canClaimStreamRun({ runClaimedAt: 1, status: "streaming" })).toBe(false);
    });
});

describe("coding-agent poll redelivery: the poll sequence", () => {
    const insertRun = async (): Promise<string> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("codingAgentRuns", {
                    agent: "claude_code",
                    createdAt: 1,
                    log: "",
                    openPr: false,
                    prompt: "p",
                    repoUrl: "https://github.com/a/b.git",
                    status: "running",
                    updatedAt: 1,
                    userId: "u1",
                }),
        );

    it("runs each poll once, so a redelivered poll cannot fork a second chain", async () => {
        const runId = await insertRun();

        expect(await runInternal(claimPoll, { runId, seq: 0 })).toBe(true);
        expect(await runInternal(claimPoll, { runId, seq: 0 })).toBe(false);
        // The next poll in the chain still runs, once.
        expect(await runInternal(claimPoll, { runId, seq: 1 })).toBe(true);
        expect(await runInternal(claimPoll, { runId, seq: 1 })).toBe(false);
        // A stale poll from before is refused too.
        expect(await runInternal(claimPoll, { runId, seq: 0 })).toBe(false);
    });

    it("starts a fresh run at sequence 0", () => {
        expect(isCurrentPoll(undefined, 0)).toBe(true);
        expect(isCurrentPoll(undefined, 1)).toBe(false);
    });
});
