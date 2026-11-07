/**
 * A sub-agent run whose worker dies mid-run. The claim refuses the queue's redelivery, so before the beat nothing
 * ended such a run until the reaper's deadline, with the wrong reason. The loop now beats while it lives, and the
 * watch fails a run whose beat stopped as interrupted and posts that to the lead. The agent run is faked; the claim,
 * the beat, the watch and the post-back are the real procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { RUN_STALE_MS } from "../chat/lib/interrupted-run";
import schema from "../schema";
import { admitSubAgentRun, beatSubAgentRun, claimRun, watchSubAgentRunBeat } from "./functions";
import { INTERRUPTED_RUN_MESSAGE } from "./logic";

const { agent, registry } = vi.hoisted(() => {
    return { agent: { calls: 0, holdMs: 0 }, registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// A beat every few milliseconds, so a run held for a moment beats inside one test.
vi.mock("../chat/lib/interrupted-run", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../chat/lib/interrupted-run")>()), RUN_BEAT_MS: 5 };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async () => {
            agent.calls += 1;

            if (agent.holdMs > 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, agent.holdMs);
                });
            }

            return { text: "done" };
        },
    };
});

const { runSubAgent } = await import("./execute");

type Harness = ReturnType<typeof lunoraTest>;

interface RunRow {
    _id: string;
    beatAt?: number;
    error?: string;
    resultPostedAt?: number;
    startedAt?: number;
    status: string;
}

let harness: Harness;
let userId: string;
let leadId: string;

beforeAll(async () => {
    registerModule(registry, "sub_agents_functions", await import("./functions"));
});

beforeEach(async () => {
    agent.calls = 0;
    agent.holdMs = 0;
    harness = lunoraTest(schema as never);
    userId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "u@example.com", emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;
    leadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Lead", userId }))) as string;
});

afterEach(() => {
    harness.close();
});

/** A one-shot run as `createRun` admits it (its job and reaper need a queue, so the row is inserted here). */
const admit = async (): Promise<string> =>
    (await harness.run(async (ctx: any) => {
        const result = await admitSubAgentRun(ctx, { parentThreadId: leadId, task: "Research the topic", toolCallId: "call-1", userId });

        if ("error" in result) {
            throw new Error(result.error);
        }

        return await ctx.db.insert("subAgentRuns", result.row);
    })) as string;

const runRow = async (runId: string) => (await harness.run(async (ctx: any) => await ctx.db.get("subAgentRuns", runId))) as RunRow;

/** The first delivery: it claimed the run, then its worker died before it reported. */
const claimThenDie = async (runId: string): Promise<number> => {
    await harness.action(async (ctx: any) => await ctx.runMutation(claimRun, { runId }));

    const { startedAt } = await runRow(runId);

    if (startedAt === undefined) {
        throw new Error("The claim did not start the run.");
    }

    return startedAt;
};

const execute = async (runId: string) => await harness.action(async (ctx: any) => await ctx.runAction(runSubAgent, { runId }));

const watch = async (runId: string, claimedAt: number, now: number) =>
    await harness.run(async (ctx: any) => await watchSubAgentRunBeat(ctx, runId as never, claimedAt, now));

const leadMessages = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", leadId))
                .collect(),
    )) as { text?: string }[];

describe("a sub-agent run whose worker died", () => {
    it("is not run again by the queue's redelivery: the claim refuses it and the run stays running", async () => {
        const runId = await admit();

        await claimThenDie(runId);
        await execute(runId);

        expect(agent.calls).toBe(0);
        expect(await runRow(runId)).toMatchObject({ status: "running" });
    });

    it("fails as interrupted once its beat is stale, and the lead hears of it at once", async () => {
        const runId = await admit();
        const claimedAt = await claimThenDie(runId);

        await watch(runId, claimedAt, claimedAt + RUN_STALE_MS - 1);

        expect(await runRow(runId)).toMatchObject({ status: "running" });

        await watch(runId, claimedAt, claimedAt + RUN_STALE_MS);

        const run = await runRow(runId);

        expect(run).toMatchObject({ error: INTERRUPTED_RUN_MESSAGE, status: "failed" });
        expect(run.resultPostedAt).toBeDefined();

        const messages = await leadMessages();
        const posted = messages.map((row) => row.text ?? "").join("\n");

        expect(posted).toContain("Sub-agent failed");
        expect(posted).toContain(INTERRUPTED_RUN_MESSAGE);
    });

    it("is left running while its loop beats", async () => {
        const runId = await admit();
        const claimedAt = await claimThenDie(runId);

        await harness.run(async (ctx: any) => await beatSubAgentRun(ctx, runId as never, claimedAt + 120_000));
        await watch(runId, claimedAt, claimedAt + RUN_STALE_MS);

        expect(await runRow(runId)).toMatchObject({ status: "running" });
    });

    it("ignores a watch from an earlier claim", async () => {
        const runId = await admit();
        const claimedAt = await claimThenDie(runId);

        await watch(runId, claimedAt - 1, claimedAt + RUN_STALE_MS);

        expect(await runRow(runId)).toMatchObject({ status: "running" });
    });
});

describe("a sub-agent run whose loop lives", () => {
    it("beats while it runs, and its late watch and beats leave the finished run alone", async () => {
        agent.holdMs = 40;

        const runId = await admit();

        await execute(runId);

        const finished = await runRow(runId);

        expect(agent.calls).toBe(1);
        expect(finished.status).toBe("succeeded");
        expect(finished.beatAt).toBeGreaterThanOrEqual(finished.startedAt!);

        await harness.run(async (ctx: any) => await beatSubAgentRun(ctx, runId as never, finished.startedAt! + 10 * RUN_STALE_MS));
        await watch(runId, finished.startedAt!, finished.startedAt! + 10 * RUN_STALE_MS);

        expect(await runRow(runId)).toMatchObject({ beatAt: finished.beatAt, status: "succeeded" });
    });
});
