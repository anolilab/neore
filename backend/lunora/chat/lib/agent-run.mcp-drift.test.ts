/**
 * An approval is given for an MCP tool as the paused run offered it. When the continuation finds the tool changed
 * (another schema or annotations) or gone, the approved call is not run: it is answered as denied, with a reason the
 * model reads. An unchanged tool runs as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import { resumeApprovedRun } from "./agent-run";

vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return { buildAgentTools: vi.fn() };
});

const TOOL = "mcp_Docs__search";

/** Thrown by the agent's approve/deny, so the run ends right where this suite looks. */
const STOP = new Error("stop");

const agent = {
    approveToolCall: vi.fn(async () => {
        throw STOP;
    }),
    denyToolCall: vi.fn(async () => {
        throw STOP;
    }),
    options: {},
};

/** The continuation's rebuilt tools: `fingerprint` absent means the server no longer offers the tool. */
const rebuiltWith = (fingerprint: string | undefined) => {
    vi.mocked(buildAgentTools).mockResolvedValue({
        autoApprovals: {},
        mcpClients: [],
        mcpLabels: {},
        mcpServerNames: ["Docs"],
        mcpToolFingerprints: fingerprint === undefined ? {} : { [TOOL]: fingerprint },
        permissionKeys: {},
        repeatable: [],
        tools: fingerprint === undefined ? {} : { [TOOL]: { execute: vi.fn() } as never },
    });
};

const resume = async (savedFingerprints: Record<string, string> | undefined, decision?: { approved: boolean; denyReason?: string }) => {
    const ctx = {
        // Every read answers like the approval lookup: the request is still the open one, for `TOOL`.
        runQuery: vi.fn(async () => {
            return { toolName: TOOL };
        }),
    };
    const config = {
        autoMediaEnrichment: false,
        mcpServerNames: ["Docs"],
        ...(savedFingerprints && { mcpToolFingerprints: savedFingerprints }),
        model: "gpt-4o",
        researchDepth: "balanced",
        searchMode: "chat",
        shouldAutoContinue: false,
        toolNames: [TOOL],
    } as never;

    return await resumeApprovedRun(ctx as never, {
        approvalId: "approval-1",
        ...(decision ?? { approved: true }),
        config,
        streamId: "stream-1",
        threadId: "thread-1",
        userId: "owner-1",
    }).catch((error: unknown) => error);
};

describe("an approved MCP call after a pause", () => {
    beforeEach(() => {
        agent.approveToolCall.mockClear();
        agent.denyToolCall.mockClear();
        vi.mocked(getAgent).mockResolvedValue(agent as never);
    });

    it("runs as approved when the tool is unchanged", async () => {
        rebuiltWith("aaa");

        expect(await resume({ [TOOL]: "aaa" })).toBe(STOP);
        expect(agent.approveToolCall).toHaveBeenCalledOnce();
        expect(agent.denyToolCall).not.toHaveBeenCalled();
    });

    it("is not run under the old approval when the tool's definition changed, and the model is told why", async () => {
        rebuiltWith("bbb");

        expect(await resume({ [TOOL]: "aaa" })).toBe(STOP);
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ approvalId: "approval-1", reason: expect.stringContaining("definition changed") }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("is not run when the tool is gone, and the model is told it is not available now", async () => {
        rebuiltWith(undefined);

        expect(await resume({ [TOOL]: "aaa" })).toBe(STOP);
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ reason: expect.stringContaining("not available now") }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("denies with the person's own reason when they denied a call whose tool is gone since", async () => {
        rebuiltWith(undefined);

        expect(await resume({ [TOOL]: "aaa" }, { approved: false, denyReason: "Not now" })).toBe(STOP);
        expect(agent.denyToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ reason: "Not now" }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("keeps the earlier check for a snapshot written before fingerprints: a gone tool is a stale approval", async () => {
        rebuiltWith(undefined);

        const outcome = await resume(undefined);

        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain("no longer available");
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).not.toHaveBeenCalled();
    });

    it("runs a snapshot written before fingerprints as before when the tool is still there", async () => {
        rebuiltWith("bbb");

        expect(await resume(undefined)).toBe(STOP);
        expect(agent.approveToolCall).toHaveBeenCalledOnce();
    });
});
