/**
 * A tool-approval continuation rebuilds its tools with the admission its stream gate
 * gave it, so the knowledge search of an admitted locked chat is not the fail-closed
 * one. Without an admission the rebuilt tools are built as before.
 */
import { describe, expect, it, vi } from "vitest";

import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import { resumeApprovedRun } from "./agent-run";
import { createAnsweredAskUserTool } from "../tools/ask-user";
import { createAnsweredRequestSecretTool } from "../tools/request-secret";

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

// Each answered tool is a marker, so a test can tell it reached the agent the continuation runs.
vi.mock("../tools/ask-user", () => {
    return {
        createAnsweredAskUserTool: vi.fn(() => {
            return { answered: "askUser" };
        }),
    };
});
vi.mock("../tools/request-secret", () => {
    return {
        createAnsweredRequestSecretTool: vi.fn(() => {
            return { answered: "requestSecret" };
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
});

describe("an answer whose tool left the rebuilt set", () => {
    /**
     * Resumes an approved `toolName` against an empty rebuilt set, which is what an `off` cap gives, and returns the tools
     * the continuation's agent was built with. The agent here is a stub, so the run stops right after it is built; what
     * matters is that the agent received the answered tool, and that the resume was not refused before it.
     */
    const toolsOfResumedAgent = async (toolName: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const resumeCtx = {
            runQuery: vi.fn(async () => {
                return { toolName };
            }),
        };

        vi.mocked(getAgent).mockClear();
        vi.mocked(getAgent).mockResolvedValue({ options: {} } as never);

        const failure = await resumeApprovedRun(resumeCtx as never, {
            approvalId: "approval-1",
            approved: true,
            config: CONFIG,
            streamId: "stream-1",
            threadId: "thread-1",
            userId: "owner-1",
            ...extra,
        })
            .then(() => undefined)
            .catch((error: unknown) => error);

        // A refusal before the agent (a stale or unanswerable approval) would leave the answer unused.
        expect(failure).not.toMatchObject({ kind: "stale-approval" });
        expect(getAgent).toHaveBeenCalledTimes(1);

        const [, options] = vi.mocked(getAgent).mock.calls[0] as unknown as [string, { tools: Record<string, unknown> }];

        return options.tools;
    };

    it("runs the person's answer to a question as the call's result, rather than recording a denial", async () => {
        const tools = await toolsOfResumedAgent("askUser", { answer: "Blue" });

        expect(createAnsweredAskUserTool).toHaveBeenLastCalledWith("Blue", [], []);
        expect(tools).toStrictEqual({ askUser: { answered: "askUser" } });
    });

    it("runs the reference to a requested secret as the call's result, rather than recording a denial", async () => {
        const tools = await toolsOfResumedAgent("requestSecret", { answer: "secret-ref-1" });

        expect(createAnsweredRequestSecretTool).toHaveBeenLastCalledWith("secret-ref-1");
        expect(tools).toStrictEqual({ requestSecret: { answered: "requestSecret" } });
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
