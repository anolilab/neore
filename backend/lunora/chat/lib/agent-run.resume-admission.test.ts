/**
 * A tool-approval continuation rebuilds its tools with the admission its stream gate
 * gave it, so the knowledge search of an admitted locked chat is not the fail-closed
 * one. Without an admission the rebuilt tools are built as before.
 */
import { describe, expect, it, vi } from "vitest";

import { buildAgentTools } from "./agent-tools";
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
});
