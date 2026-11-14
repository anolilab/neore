/**
 * A sub-agent child of a task that paused is answered: its continuation is rebuilt from the snapshot, and what it delegates
 * next must still count toward the task's one-waiting-child limit. The approved call here is the child's delegation, which
 * reads the chain from its tool context as `delegateToSubAgent` does; admission is the real one.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../schema";
import { admitSubAgentRun } from "../../sub-agents/functions";
import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import { resumeApprovedRun } from "./agent-run";

vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return { buildAgentTools: vi.fn() };
});

const TOOL = "delegateToSubAgent";
const CHAIN_WAITS = /this task started earlier is still waiting/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let userId: string;
let delegated: unknown;

const insertThread = async () => (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId }))) as string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    userId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "u@example.com", emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

    // Another child of the same task, started by an earlier round in a thread of its own, waits for the owner.
    const earlierRound = await insertThread();

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

    vi.mocked(buildAgentTools).mockResolvedValue({
        autoApprovals: {},
        mcpClients: [],
        mcpLabels: {},
        mcpServerNames: [],
        mcpToolFingerprints: {},
        permissionKeys: {},
        repeatable: [],
        requiresApproval: [],
        tools: { [TOOL]: { execute: vi.fn() } as never },
    });

    const childThread = await insertThread();

    // The approved delegation: admitted with the chain its tool context carries.
    vi.mocked(getAgent).mockResolvedValue({
        approveToolCall: vi.fn(async (toolCtx: { chainSource?: string }) => {
            delegated = await harness.run(
                async (ctx: any) =>
                    await admitSubAgentRun(ctx, {
                        ...(toolCtx.chainSource !== undefined && { chainSource: toolCtx.chainSource }),
                        parentThreadId: childThread,
                        task: "Nested",
                        toolCallId: "call-nested",
                        userId,
                    }),
            );

            throw new Error("stop");
        }),
        options: {},
    } as never);
});

afterEach(() => {
    harness.close();
});

const resume = async (chainSource: string | undefined) =>
    await resumeApprovedRun(
        {
            runQuery: vi.fn(async () => {
                return { toolName: TOOL };
            }),
        } as never,
        {
            approvalId: "approval-1",
            approved: true,
            config: {
                autoMediaEnrichment: false,
                ...(chainSource !== undefined && { chainSource }),
                mcpServerNames: [],
                model: "gpt-4o",
                researchDepth: "balanced",
                searchMode: "chat",
                shouldAutoContinue: false,
                stepsLeft: 5,
                subAgentRunId: "run-1",
                toolNames: [TOOL],
            } as never,
            streamId: "stream-1",
            threadId: "thread-1",
            userId,
        },
    ).catch(() => undefined);

describe("a resumed sub-agent child's own delegation", () => {
    it("is refused while another child of its task waits", async () => {
        await resume("task:t1");

        expect(delegated).toStrictEqual({ error: expect.stringMatching(CHAIN_WAITS) });
    });

    it("falls back to the per-thread cap for a snapshot written before the chain source", async () => {
        await resume(undefined);

        expect(delegated).toHaveProperty("row");
    });
});
