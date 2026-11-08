/**
 * A tool-approval continuation rebuilds its tools with the admission its stream gate
 * gave it, so the knowledge search of an admitted locked chat is not the fail-closed
 * one. Without an admission the rebuilt tools are built as before.
 */
import { describe, expect, it, vi } from "vitest";
import z from "zod/v4";

import { createTool } from "../../agent/client/create-tool";

import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import { resumeApprovedRun } from "./agent-run";

// The rebuilt tools and the agent are not what this checks: the run stops at the approval lookup.
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

const CONFIG = { autoMediaEnrichment: false, mcpServerNames: [], model: "gpt-4o", searchMode: "chat", toolNames: [] } as never;

/** A context whose approval lookup finds nothing, so the resume stops before the agent runs. */
const ctx = {
    runQuery: vi.fn(async () => null),
};

const resume = async (options?: { admittedRun?: boolean }) =>
    await resumeApprovedRun(
        ctx as never,
        { approvalId: "approval-1", approved: true, config: CONFIG, streamId: "stream-1", threadId: "thread-1", userId: "owner-1" },
        options,
    ).catch(() => undefined);

describe(resumeApprovedRun, () => {
    it("builds the rebuilt tools for an admitted continuation, so its knowledge search can read the chat's own files", async () => {
        vi.mocked(buildAgentTools).mockClear();

        await resume({ admittedRun: true });

        expect(buildAgentTools).toHaveBeenCalledWith(ctx, expect.objectContaining({ admittedRun: true, deviceThreadId: "thread-1" }));
    });

    it("builds the rebuilt tools without an admission when none is given, so the fail-closed search stays", async () => {
        vi.mocked(buildAgentTools).mockClear();

        await resume();

        const [, args] = vi.mocked(buildAgentTools).mock.calls[0] as unknown as [unknown, Record<string, unknown>];

        expect(args).not.toHaveProperty("admittedRun");
    });

    it("rebuilds a sub-agent child's tools headless, so no time grant or quick check answers its other ask tools", async () => {
        vi.mocked(buildAgentTools).mockClear();

        await resumeApprovedRun(ctx as never, {
            approvalId: "approval-1",
            approved: true,
            config: { ...(CONFIG as object), headlessApproved: ["delegateToSubAgent"], subAgentRunId: "run-1" } as never,
            streamId: "stream-1",
            threadId: "thread-1",
            userId: "owner-1",
        }).catch(() => undefined);

        expect(buildAgentTools).toHaveBeenCalledWith(
            ctx,
            expect.objectContaining({ headless: true, headlessApproved: ["delegateToSubAgent"], headlessCanAsk: true }),
        );
    });
});

describe("a headless pause's continuation", () => {
    const resumeWith = async (config: Record<string, unknown>) => {
        const approveToolCall = vi.fn(async () => {
            throw new Error("stop here");
        });

        vi.mocked(getAgent).mockClear();
        vi.mocked(getAgent).mockResolvedValue({ approveToolCall, options: {} } as never);

        const error = await resumeApprovedRun(
            {
                runQuery: vi.fn(async () => {
                    return { toolName: null };
                }),
            } as never,
            {
                approvalId: "approval-1",
                approved: true,
                config: { ...(CONFIG as object), ...config } as never,
                streamId: "stream-1",
                threadId: "thread-1",
                userId: "owner-1",
            },
        ).catch((error_: unknown) => error_);

        return { approveToolCall, error };
    };

    it("runs at most the steps a sub-agent child's run had left, and none once they are spent", async () => {
        await resumeWith({ stepsLeft: 2, subAgentRunId: "run-1" });
        expect(getAgent).toHaveBeenCalledWith("gpt-4o", expect.objectContaining({ maxSteps: 2 }));

        const { approveToolCall, error } = await resumeWith({ stepsLeft: 0, subAgentRunId: "run-1" });

        expect(String(error)).toContain("no steps left");
        expect(getAgent).not.toHaveBeenCalled();
        expect(approveToolCall).not.toHaveBeenCalled();
    });

    it("offers a sub-agent child no ask tool on its last step left, and an interactive continuation every tool", async () => {
        const lastStep = async (config: Record<string, unknown>) => {
            vi.mocked(buildAgentTools).mockResolvedValueOnce({
                mcpClients: [],
                mcpLabels: {},
                mcpServerNames: [],
                permissionKeys: {},
                requiresApproval: ["asks"],
                // A real tool, as every built-in is: it carries a `needsApproval` function, which never asks.
                tools: { asks: { needsApproval: true }, plain: createTool({ description: "Plain", execute: async () => "done", inputSchema: z.object({}) }) },
            } as never);

            const { approveToolCall } = await resumeWith(config);
            const streamArgs = (approveToolCall.mock.calls[0] as unknown[])[3] as {
                prepareStep: (step: { messages: unknown[]; stepNumber: number }) => Promise<{ activeTools?: string[] } | undefined>;
            };

            const prepared = await streamArgs.prepareStep({ messages: [], stepNumber: 0 });

            return prepared?.activeTools;
        };

        expect(await lastStep({ stepsLeft: 1, subAgentRunId: "run-1" })).toStrictEqual(["plain"]);
        expect(await lastStep({ stepsLeft: 1 })).toBeUndefined();
    });

    it("gives an interactive continuation its full budget, whatever stepsLeft its snapshot holds", async () => {
        const { approveToolCall } = await resumeWith({ stepsLeft: 0 });

        expect(getAgent).toHaveBeenCalledWith("gpt-4o", expect.objectContaining({ maxSteps: 5 }));
        expect(approveToolCall).toHaveBeenCalled();
    });

    it("reads the thread from a fresh-context run's own prompt, not the turns before it", async () => {
        const { approveToolCall } = await resumeWith({ contextFromOrder: 4 });

        expect(approveToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ contextOptions: { fromOrder: 4 } }),
        );
    });
});

describe("the dispatch origin of a resumed run", () => {
    /** Runs a resume far enough to set the origin its tools will dispatch with. */
    const originAfterResume = async (config: Record<string, unknown>) => {
        const resumeCtx: { dispatchOrigin?: string; runQuery: (...args: unknown[]) => Promise<unknown> } = {
            runQuery: vi.fn(async () => {
                return { toolName: null };
            }),
        };

        vi.mocked(getAgent).mockResolvedValue({ options: {} } as never);

        await resumeApprovedRun(resumeCtx as never, {
            approvalId: "approval-1",
            approved: true,
            config: { ...(CONFIG as object), ...config } as never,
            streamId: "stream-1",
            threadId: "thread-1",
            userId: "owner-1",
        }).catch(() => undefined);

        return resumeCtx.dispatchOrigin;
    };

    it("is the lead's when the snapshot names none", async () => {
        expect(await originAfterResume({})).toBe("lead");
    });

    it("stays an outside agent's when the run that paused was one, so its workers' policy still applies", async () => {
        expect(await originAfterResume({ dispatchOrigin: "outside_agent" })).toBe("outside_agent");
    });
});
