/**
 * `runSubAgent` for a worker: every run continues the worker's one child thread, a user-typed
 * message is the prompt as written, and a redelivered job runs nothing. The agent run is faked;
 * claim, completion and the rest are the real procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { admitSubAgentRun, admitWorkerRun } from "./functions";
import { WORKER_SYSTEM } from "./logic";

const { contexts, probe, registry, runs } = vi.hoisted(() => {
    return {
        contexts: [] as string[][],
        probe: { on: false, pause: undefined as ((options: Record<string, any>) => Promise<void>) | undefined },
        registry: new Map<string, unknown>(),
        runs: [] as Record<string, any>[],
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (ctx: any, options: Record<string, any>) => {
            runs.push(options);

            const text = `reply ${String(runs.length)}`;

            // A run that stopped on an approval request.
            if (probe.pause) {
                await probe.pause(options);

                return { paused: true, text, threadId: options.thread.threadId };
            }

            if (probe.on) {
                // What the agent reads as history, then what a real run saves into the thread.
                const { threadId } = options.thread;
                const { fetchContextMessages } = await import("../agent/client/search");
                const { internal } = await import("../_generated/internal");
                const history = await fetchContextMessages(ctx, {} as never, { contextOptions: { recentMessages: 50 }, threadId, userId: options.userId });

                contexts.push(history.map((row) => row.text ?? ""));
                await ctx.runMutation(internal.agent.messages.addMessages, {
                    fromUser: true,
                    messages: [
                        { message: { content: options.prompt, role: "user" }, status: "success" },
                        { message: { content: text, role: "assistant" }, status: "success" },
                    ],
                    threadId,
                    userId: options.userId,
                });
            }

            return { text, threadId: options.thread.threadId };
        },
    };
});

const { runSubAgent } = await import("./execute");

const CHAIN_WAITS = /this task started earlier is still waiting/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let userId: string;
let leadId: string;

beforeAll(async () => {
    registerModule(registry, "sub_agents_functions", await import("./functions"));
    registerModule(registry, "tasks_internal", await import("../tasks/internal"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
});

beforeEach(async () => {
    runs.length = 0;
    contexts.length = 0;
    probe.on = false;
    probe.pause = undefined;
    harness = lunoraTest(schema as never);
    userId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "u@example.com", emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;
    leadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Lead", userId }))) as string;
});

afterEach(() => {
    harness.close();
});

const dispatch = async (extra: Record<string, unknown>) => {
    const result = await harness.run(
        async (ctx: any) => await admitWorkerRun(ctx, { name: "Researcher", parentThreadId: leadId, task: "Look into it", userId, ...extra }),
    );

    if ("error" in result) {
        throw new Error(result.error);
    }

    return result.run as { _id: string; childThreadId: string };
};

const execute = async (runId: string) => await harness.action(async (ctx: any) => await ctx.runAction(runSubAgent, { runId }));

describe("a worker's runs", () => {
    it("continue one child thread: the lead's task is wrapped, the user's message is not, and the second sees the first's thread", async () => {
        const first = await dispatch({ toolCallId: "call-1" });

        await execute(first._id);

        const second = await dispatch({ childThreadId: first.childThreadId, clientId: "client-1", task: "What about the second part?" });

        await execute(second._id);

        expect(runs).toHaveLength(2);
        expect(runs[0]).toMatchObject({ prompt: expect.stringContaining("Look into it"), system: WORKER_SYSTEM, thread: { threadId: first.childThreadId } });
        expect(runs[0]!.prompt).not.toBe("Look into it");
        expect(runs[1]).toMatchObject({ prompt: "What about the second part?", system: WORKER_SYSTEM, thread: { threadId: first.childThreadId } });
        expect(second.childThreadId).toBe(first.childThreadId);

        const rows = (await harness.run(async (ctx: any) => await ctx.db.query("subAgentRuns").collect())) as { status: string }[];

        expect(rows.map((row) => row.status)).toStrictEqual(["succeeded", "succeeded"]);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("threads").collect())).toHaveLength(2);
    });

    it("builds the second run's context from the first run's saved reply", async () => {
        probe.on = true;

        const first = await dispatch({ toolCallId: "call-1" });

        await execute(first._id);

        const second = await dispatch({ childThreadId: first.childThreadId, clientId: "client-1", task: "What about the second part?" });

        await execute(second._id);

        expect(contexts).toHaveLength(2);
        expect(contexts[0]).toStrictEqual([]);
        expect(contexts[1]).toContain("reply 1");
    });

    it("runs on the worker thread's model, not the lead's", async () => {
        const first = await dispatch({ model: "anthropic/claude-sonnet-4", parentModel: "anthropic/claude-sonnet-4.5", toolCallId: "call-1" });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", first.childThreadId, { model: "anthropic/claude-sonnet-4.5" }));
        await execute(first._id);

        expect(runs[0]!.model).toBe("anthropic/claude-sonnet-4.5");
    });

    it("runs a redelivered job once", async () => {
        const first = await dispatch({ toolCallId: "call-1" });

        await execute(first._id);
        await execute(first._id);

        expect(runs).toHaveLength(1);
    });
});

describe("whether a child may pause for its owner", () => {
    /** A one-shot run as the claim finds it, run once, and the options its headless run got. */
    const oneShot = async (fields: Record<string, unknown>) => {
        const runId = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("subAgentRuns", {
                    createdAt: Date.now(),
                    depth: 1,
                    parentThreadId: leadId,
                    status: "queued",
                    task: "Tidy up",
                    toolCallId: "call-1",
                    updatedAt: Date.now(),
                    userId,
                    ...fields,
                }),
        )) as string;

        await execute(runId);

        return runs.at(-1)!;
    };

    it("pauses a one-shot child of the owner's own turn, and withholds the dispatch tools at the depth cap", async () => {
        expect(await oneShot({})).toMatchObject({ pauseForApproval: { subAgentRunId: expect.any(String) } });
        expect(runs.at(-1)).not.toHaveProperty("withheldTools");
        expect(await oneShot({ depth: 2 })).toMatchObject({ withheldTools: ["delegateToSubAgent", "messageWorker"] });
    });

    it("pauses a one-shot child of a task's chain, which keeps its origin and passes the task on to what it starts", async () => {
        expect(await oneShot({ chainSource: "task:t1", dispatchedBy: "trigger" })).toMatchObject({
            chainSource: "task:t1",
            origin: "trigger",
            pauseForApproval: { subAgentRunId: expect.any(String) },
        });
    });

    it("never pauses a child of an eval's chain: its `ask` tools are refused as in any headless run", async () => {
        const options = await oneShot({ chainSource: "eval:r1", dispatchedBy: "trigger" });

        expect(options).toMatchObject({ chainSource: "eval:r1", origin: "trigger" });
        expect(options).not.toHaveProperty("pauseForApproval");
    });

    it("never pauses a worker", async () => {
        const worker = await dispatch({ toolCallId: "call-w" });

        await execute(worker._id);
        expect(runs.at(-1)).not.toHaveProperty("pauseForApproval");
    });

    // The worker's run names its chain on its tool context (`runHeadlessAgent`), which its `delegateToSubAgent` admits under.
    it("never pauses a worker of an eval's chain, nor the one-shot child it delegates", async () => {
        const worker = await dispatch({ chainSource: "eval:r1", toolCallId: "call-w" });

        await execute(worker._id);

        const workerRun = runs.at(-1)!;

        expect(workerRun).toMatchObject({ chainSource: "eval:r1" });
        expect(workerRun).not.toHaveProperty("pauseForApproval");
        expect(await oneShot({ chainSource: workerRun.chainSource, parentThreadId: worker.childThreadId })).not.toHaveProperty("pauseForApproval");
    });

    it("counts a task worker's one-shot child toward the task's limit of one waiting child", async () => {
        const earlierRound = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Earlier", userId }))) as string;

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("subAgentRuns", {
                    chainSource: "task:t1",
                    createdAt: 0,
                    depth: 1,
                    parentThreadId: earlierRound,
                    status: "awaiting",
                    task: "Earlier",
                    updatedAt: 0,
                    userId,
                }),
        );

        const worker = await dispatch({ chainSource: "task:t1", toolCallId: "call-w" });

        await execute(worker._id);

        const { chainSource } = runs.at(-1)!;
        const nested = await harness.run(
            async (ctx: any) =>
                await admitSubAgentRun(ctx, { chainSource, parentThreadId: worker.childThreadId, task: "Nested", toolCallId: "nested", userId }),
        );

        expect(nested).toStrictEqual({ error: expect.stringMatching(CHAIN_WAITS) });
    });
});

describe("a one-shot child that pauses", () => {
    it("does not wait again when its owner answered before the run recorded its wait", async () => {
        const runId = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("subAgentRuns", {
                    createdAt: Date.now(),
                    depth: 1,
                    parentThreadId: leadId,
                    status: "queued",
                    task: "Tidy up",
                    toolCallId: "call-1",
                    updatedAt: Date.now(),
                    userId,
                }),
        )) as string;

        // The pause's request is recorded and already answered: the answer resumed the run (a deadline of its own), and a
        // sibling request of the same step is still open on the child's latest turn.
        probe.pause = async () =>
            await harness.run(async (ctx: any) => {
                const childId = await ctx.db.insert("threads", { status: "active", title: "Sub-agent: Tidy up", userId });

                await ctx.db.patch("subAgentRuns", runId, { childThreadId: childId, reapAt: Date.now() + 60_000, status: "running" });
                await ctx.db.insert("messages", {
                    message: {
                        content: [
                            { input: {}, toolCallId: "call-2", toolName: "mcp_Files__delete", type: "tool-call" },
                            { approvalId: "approval-2", toolCallId: "call-2", type: "tool-approval-request" },
                        ],
                        role: "assistant",
                    },
                    order: 0,
                    status: "success",
                    stepOrder: 1,
                    threadId: childId,
                    tool: true,
                    userId,
                });
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: "approval-2",
                    config: {
                        autoMediaEnrichment: false,
                        mcpServerNames: [],
                        model: "test-model",
                        researchDepth: "balanced",
                        searchMode: "web",
                        shouldAutoContinue: true,
                        subAgentRunId: runId,
                        toolNames: [],
                    },
                    createdAt: Date.now(),
                    status: "pending",
                    threadId: childId,
                    userId,
                });
            });

        await execute(runId);

        const run = await harness.run(async (ctx: any) => await ctx.db.get("subAgentRuns", runId));

        expect(run.status).toBe("running");
    });
});
