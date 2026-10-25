/**
 * Memory extraction across a tool-approval pause. The run that paused hands it to the
 * continuation (`memoryToCarry`), which extracts the exchange once, with the prompt and
 * every message steered into the reply on either side of the pause.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { memoryToCarry, resumeApprovedRun } from "./agent-run";
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
const CARRIED = { prompt: "Plan my dinner", steeredTexts: ["no nuts"] };

const reply = { _id: "r1", message: { content: "Here is a plan.", role: "assistant" }, order: 2, stepOrder: 1 };
const pausedAgain = {
    _id: "r2",
    message: { content: [{ approvalId: "approval-2", toolCallId: "call-2", type: "tool-approval-request" }], role: "assistant" },
    order: 3,
    stepOrder: 1,
};

/** Runs a steerable continuation that takes one steer, and returns the scheduled jobs and recorded snapshots. */
const resume = async (config: ToolRunConfig, savedMessages: unknown[], memoryEnabled = true) => {
    const runAfter = vi.fn(async () => "job");
    const runMutation = vi.fn(async (ref: unknown) =>
        ref === internal.chat.steering.deliverSteers ? { messageId: "steer-1", text: "actually, vegetarian" } : null,
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

describe(memoryToCarry, () => {
    it("carries the prompt, cut to what extraction reads, with the steers and the bot", () => {
        const carried = memoryToCarry({ botId: "bot-1", extractMemory: true, prompt: "x".repeat(5000), steeredTexts: ["a"] });

        expect(carried).toStrictEqual({ botId: "bot-1", prompt: "x".repeat(2000), steeredTexts: ["a"] });
    });

    it("carries nothing for a run that is not mined", () => {
        expect(memoryToCarry({ extractMemory: false, prompt: "hi", steeredTexts: [] })).toBeUndefined();
        expect(memoryToCarry({ extractMemory: true, prompt: "", steeredTexts: [] })).toBeUndefined();
    });
});

describe("a tool-approval continuation", () => {
    it("extracts memory once, from the carried prompt and every steer on both sides of the pause", async () => {
        const { jobs } = await resume({ ...BASE_CONFIG, memory: CARRIED }, [reply]);
        const extractions = jobs(internal.memory.extract.extractMemories);

        expect(extractions).toHaveLength(1);
        expect(extractions[0]).toMatchObject({
            assistantResponse: "Here is a plan.",
            steeredFrom: "Plan my dinner".length + 2,
            userMessage: "Plan my dinner\n\nno nuts\n\nactually, vegetarian",
        });
    });

    it("extracts nothing when the run that paused was not mined, or memory was switched off meanwhile", async () => {
        expect(jobs0(await resume(BASE_CONFIG, [reply]))).toHaveLength(0);
        expect(jobs0(await resume({ ...BASE_CONFIG, memory: CARRIED }, [reply], false))).toHaveLength(0);
    });

    it("leaves extraction to the next continuation when it pauses again, and hands it every steer so far", async () => {
        const { jobs, runMutation } = await resume({ ...BASE_CONFIG, memory: CARRIED }, [pausedAgain]);

        expect(jobs(internal.memory.extract.extractMemories)).toHaveLength(0);

        const recorded = runMutation.mock.calls.find((call) => (call as unknown[])[0] === internal.chat.tool_permissions.recordPendingToolApprovals);

        expect((recorded as unknown[] | undefined)?.[1]).toMatchObject({
            config: { memory: { prompt: "Plan my dinner", steeredTexts: ["no nuts", "actually, vegetarian"] } },
        });
    });
});

const jobs0 = (run: { jobs: (ref: unknown) => unknown[] }) => run.jobs(internal.memory.extract.extractMemories);
