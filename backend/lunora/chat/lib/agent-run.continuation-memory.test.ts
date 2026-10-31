/**
 * Memory extraction across a tool-approval pause. The run that paused extracts its own prompt and the
 * messages steered into it before the pause (`afterRun`), so an approval that never completes loses
 * nothing. It leaves a flag in the snapshot (`memoryToCarry`); the continuation extracts only the
 * messages steered into it after the pause.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { afterRun, memoryToCarry, resumeApprovedRun } from "./agent-run";
import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import type { ToolRunConfig } from "./tool-run-config";

vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return {
        buildAgentTools: vi.fn(async () => {
            return { mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools: {} };
        }),
    };
});

const BASE_CONFIG = { autoMediaEnrichment: false, mcpServerNames: [], model: "gpt-4o", searchMode: "chat", toolNames: [] } as unknown as ToolRunConfig;
const CARRIED = { botId: "bot-1" };

const reply = { _id: "r1", message: { content: "Here is a plan.", role: "assistant" }, order: 2, stepOrder: 1 };
const pausedAgain = {
    _id: "r2",
    message: { content: [{ approvalId: "approval-2", toolCallId: "call-2", type: "tool-approval-request" }], role: "assistant" },
    order: 3,
    stepOrder: 1,
};

/** Runs a steerable continuation that takes one steer (unless `steered` is off), and returns the scheduled jobs and recorded snapshots. */
const resume = async (config: ToolRunConfig, savedMessages: unknown[], memoryEnabled = true, steered = true) => {
    const runAfter = vi.fn(async () => "job");
    const runMutation = vi.fn(async (ref: unknown) =>
        ref === internal.chat.steering.deliverSteers && steered ? { messageId: "steer-1", text: "actually, vegetarian" } : null,
    );
    const runQuery = vi.fn(async (ref: unknown) => {
        if (ref === internal.chat.tool_permissions.getPendingToolApproval) {
            return { toolName: null };
        }

        if (ref === internal.auth.functions.getUserPreferencesQuery) {
            return { memoryEnabled, timezone: "Europe/Berlin" };
        }

        return ref === internal.auth.functions.getDecryptedProviderKeysQuery ? {} : null;
    });
    const agent = {
        approveToolCall: vi.fn(
            async (_ctx: unknown, _ids: unknown, _approval: unknown, _args: unknown, runOptions: { takeSteer: (a: unknown) => Promise<unknown> }) => {
                await runOptions.takeSteer({ pendingMessageId: "p1" });

                return { consumeStream: async () => {}, fullStream: (async function* none() {})(), order: 2, promptMessageId: "tool-result-1", savedMessages };
            },
        ),
        options: {},
    };

    vi.mocked(getAgent).mockResolvedValue(agent as never);
    vi.mocked(buildAgentTools).mockClear();

    await resumeApprovedRun(
        { runMutation, runQuery, scheduler: { runAfter } } as never,
        { approvalId: "approval-1", approved: true, config, streamId: "stream-1", threadId: "thread-1", userId: "owner-1" },
        { steerable: true },
    );

    const jobs = (ref: unknown) => runAfter.mock.calls.filter((call) => (call as unknown[])[1] === ref).map((call) => (call as unknown[])[2]);

    return { jobs, runMutation };
};

/** What `runStreamingAgent` records when a run ends at a pause: `afterRun` over the prompt and the steers so far. */
const pauseRun = (runAfter: ReturnType<typeof vi.fn>) =>
    afterRun({ runMutation: vi.fn(async () => null), scheduler: { runAfter } } as never, {
        extractMemory: true,
        firstTokenTime: undefined,
        prompt: "Plan my dinner",
        savedMessages: [{ _id: "r0", message: { content: "Let me check.", role: "assistant" }, order: 1, stepOrder: 1 }] as never,
        steeredTexts: ["no nuts"],
        threadId: "thread-1",
        timingStart: Date.now(),
        userId: "owner-1",
    });

describe(memoryToCarry, () => {
    it("carries a flag and the bot, not the prompt or the steers", () => {
        expect(memoryToCarry({ botId: "bot-1", extractMemory: true, prompt: "x".repeat(5000) })).toStrictEqual({ botId: "bot-1" });
        expect(memoryToCarry({ extractMemory: true, prompt: "hi" })).toStrictEqual({});
    });

    it("carries nothing for a run that is not mined", () => {
        expect(memoryToCarry({ extractMemory: false, prompt: "hi" })).toBeUndefined();
        expect(memoryToCarry({ extractMemory: true, prompt: "" })).toBeUndefined();
    });
});

describe("a run that pauses on a tool approval", () => {
    it("extracts the prompt and the steers so far at the pause, so an approval left unanswered loses nothing", () => {
        const runAfter = vi.fn(async () => "job");

        pauseRun(runAfter);

        const extractions = runAfter.mock.calls.filter((call) => (call as unknown[])[1] === internal.memory.extract.extractMemories);

        expect(extractions).toHaveLength(1);
        expect((extractions[0] as unknown[])[2]).toMatchObject({ userMessage: "Plan my dinner\n\nno nuts" });
    });
});

describe("a tool-approval continuation", () => {
    it("extracts only the steers it took after the pause, leaving the prompt and earlier steers to the pause", async () => {
        const { jobs } = await resume({ ...BASE_CONFIG, memory: CARRIED }, [reply]);
        const extractions = jobs(internal.memory.extract.extractMemories);

        expect(extractions).toHaveLength(1);
        expect(extractions[0]).toMatchObject({ assistantResponse: "Here is a plan.", botId: "bot-1", userMessage: "actually, vegetarian" });
        expect(extractions[0]).not.toHaveProperty("steeredFrom");
    });

    it("extracts the exchange once in all: the prompt and the earlier steer at the pause, the later steer after it", async () => {
        const runAfter = vi.fn(async () => "job");

        pauseRun(runAfter);

        const { jobs } = await resume({ ...BASE_CONFIG, memory: CARRIED }, [reply]);
        const texts = [
            ...runAfter.mock.calls.filter((call) => (call as unknown[])[1] === internal.memory.extract.extractMemories).map((call) => (call as unknown[])[2]),
            ...jobs(internal.memory.extract.extractMemories),
        ].map((job) => (job as { userMessage: string }).userMessage);

        expect(texts).toStrictEqual(["Plan my dinner\n\nno nuts", "actually, vegetarian"]);
    });

    it("extracts nothing when it took no steer, the run that paused was not mined, or memory was switched off meanwhile", async () => {
        const quiet = await resume({ ...BASE_CONFIG, memory: CARRIED }, [reply], true, false);

        expect(jobs0(quiet)).toHaveLength(0);
        expect(jobs0(await resume(BASE_CONFIG, [reply]))).toHaveLength(0);
        expect(jobs0(await resume({ ...BASE_CONFIG, memory: CARRIED }, [reply], false))).toHaveLength(0);
    });

    it("extracts nothing when it pauses again with no text yet, and hands the next approval the same snapshot", async () => {
        const { jobs, runMutation } = await resume({ ...BASE_CONFIG, memory: CARRIED }, [pausedAgain]);

        expect(jobs(internal.memory.extract.extractMemories)).toHaveLength(0);

        const recorded = runMutation.mock.calls.find((call) => (call as unknown[])[0] === internal.chat.tool_permissions.recordPendingToolApprovals);

        expect((recorded as unknown[] | undefined)?.[1]).toMatchObject({ config: { memory: CARRIED } });
    });
});

const jobs0 = (run: { jobs: (ref: unknown) => unknown[] }) => run.jobs(internal.memory.extract.extractMemories);

describe("who started the turn a continuation resumes", () => {
    const resumeWith = async (config: ToolRunConfig) => {
        const ctx: Record<string, unknown> & { startedBy?: string } = {
            runMutation: vi.fn(async () => null),
            runQuery: vi.fn(async (ref: unknown) => {
                if (ref === internal.chat.tool_permissions.getPendingToolApproval) {
                    return { toolName: null };
                }

                if (ref === internal.auth.functions.getUserPreferencesQuery) {
                    return { memoryEnabled: false };
                }

                return ref === internal.auth.functions.getDecryptedProviderKeysQuery ? {} : null;
            }),
            scheduler: { runAfter: vi.fn(async () => "job") },
        };
        let seen: string | undefined;
        const agent = {
            approveToolCall: vi.fn(async () => {
                seen = ctx.startedBy;

                return {
                    consumeStream: async () => {},
                    fullStream: (async function* none() {})(),
                    order: 2,
                    promptMessageId: "tool-result-1",
                    savedMessages: [],
                };
            }),
            options: {},
        };

        vi.mocked(getAgent).mockResolvedValue(agent as never);
        await resumeApprovedRun(ctx as never, {
            approvalId: "approval-1",
            approved: true,
            config,
            streamId: "stream-1",
            threadId: "thread-1",
            userId: "owner-1",
        });

        return seen;
    };

    it("is the starter the snapshot names, not the owner the continuation runs as", async () => {
        expect(await resumeWith({ ...BASE_CONFIG, startedBy: "collaborator-1" })).toBe("collaborator-1");
    });

    it("is nobody for a snapshot that does not say", async () => {
        expect(await resumeWith(BASE_CONFIG)).toBeUndefined();
    });
});
