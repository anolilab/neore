/**
 * An approval is given for an MCP tool as the paused run offered it. When the continuation finds the tool changed
 * (another schema or annotations) or gone, the approved call is not run: it is answered as denied, with a reason the
 * model reads. An unchanged tool runs as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentTools } from "./agent-tools";
import getAgent from "./get-agent";
import { resumeApprovedRun } from "./agent-run";
import { mcpToolOrigin } from "./mcp-tool-fingerprint";

vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return { buildAgentTools: vi.fn() };
});

const TOOL = "mcp_Docs__search";

/** Which server's tool `TOOL` stood for when the run paused. */
const DOCS_ORIGIN: Record<string, string> = { [TOOL]: "docs" };

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

/** The continuation's rebuilt tools: `fingerprint` absent means the server no longer offers the tool, unless `offered`. */
const rebuiltWith = (fingerprint: string | undefined, offered = fingerprint !== undefined, origins: Record<string, string> = offered ? DOCS_ORIGIN : {}) => {
    vi.mocked(buildAgentTools).mockResolvedValue({
        autoApprovals: {},
        mcpClients: [],
        mcpLabels: {},
        mcpServerNames: ["Docs"],
        mcpToolFingerprints: fingerprint === undefined ? {} : { [TOOL]: fingerprint },
        mcpToolOrigins: origins,
        permissionKeys: {},
        repeatable: [],
        requiresApproval: [],
        tools: offered ? { [TOOL]: { execute: vi.fn() } as never } : {},
    });
};

const resume = async (
    savedFingerprints: Record<string, string> | undefined,
    decision?: { approved: boolean; denyReason?: string },
    // `null`: a snapshot written before origins were recorded.
    savedOrigins: Record<string, string> | null = DOCS_ORIGIN,
) => {
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
        ...(savedOrigins && { mcpToolOrigins: savedOrigins }),
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

    it("is not run when the tool is still offered but could not be checked, and the model is told it is still available", async () => {
        rebuiltWith(undefined, true);

        expect(await resume({ [TOOL]: "aaa" })).toBe(STOP);
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ reason: expect.stringContaining("could not be checked") }),
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

    // Not a stale approval: the approval is already claimed, so a refusal would leave the request unanswerable. It is
    // answered as denied, as a tool the organization's cap removed is.
    it("answers a call whose tool is gone as denied for a snapshot written before fingerprints", async () => {
        rebuiltWith(undefined);

        expect(await resume(undefined, undefined, null)).toBe(STOP);
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ reason: expect.stringContaining("no longer available") }),
            expect.anything(),
            expect.anything(),
        );
    });

    // Runtime names are given in listing order: once the servers listed change (a bot's selection, a server switched off), the
    // approved name can pass to another server's tool. Fingerprinted or not, that tool is not run under the approval.
    it("is not run when the approved name now stands for another server's tool, even with no fingerprint", async () => {
        rebuiltWith(undefined, true, { [TOOL]: "other-server" });

        expect(await resume(undefined)).toBe(STOP);
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ reason: expect.stringContaining("another server's tool") }),
            expect.anything(),
            expect.anything(),
        );

        agent.denyToolCall.mockClear();
        rebuiltWith("aaa", true, { [TOOL]: "other-server" });

        expect(await resume({ [TOOL]: "aaa" })).toBe(STOP);
        expect(agent.approveToolCall).not.toHaveBeenCalled();
        expect(agent.denyToolCall).toHaveBeenCalledOnce();
    });

    // With no fingerprint at the pause (it failed or timed out), the origin alone pins where the call goes.
    describe("with no fingerprint, under the origin each run computed", () => {
        const DOCS = { endpoint: "https://docs.example.com/mcp", protocol: "http", serverName: "Docs", toolName: "search" };
        const NOTION = { ...DOCS, connectorSlug: "notion", endpoint: "https://mcp.notion.example/mcp", serverName: "Notion" };
        const origins = async (source: Parameters<typeof mcpToolOrigin>[0]) => {
            return { [TOOL]: await mcpToolOrigin(source) };
        };
        const deniedAsReplaced = () => {
            expect(agent.approveToolCall).not.toHaveBeenCalled();
            expect(agent.denyToolCall).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ reason: expect.stringContaining("another server's tool") }),
                expect.anything(),
                expect.anything(),
            );
        };

        it("runs when the server is the same", async () => {
            rebuiltWith(undefined, true, await origins(DOCS));

            expect(await resume({}, undefined, await origins({ ...DOCS }))).toBe(STOP);
            expect(agent.approveToolCall).toHaveBeenCalledOnce();
        });

        it("is not run when the server's transport changed", async () => {
            rebuiltWith(undefined, true, await origins({ ...DOCS, protocol: "sse" }));

            expect(await resume({}, undefined, await origins(DOCS))).toBe(STOP);
            deniedAsReplaced();
        });

        it("is not run when a connector's endpoint changed", async () => {
            rebuiltWith(undefined, true, await origins({ ...NOTION, endpoint: "https://elsewhere.example/mcp" }));

            expect(await resume({}, undefined, await origins(NOTION))).toBe(STOP);
            deniedAsReplaced();
        });

        // The hash before transport and endpoint joined it: an approval paused under it is asked again, never run, never an error.
        it("is not run under an origin an earlier version recorded, and the model is told to call again", async () => {
            const legacy = new TextEncoder().encode(JSON.stringify({ server: { name: "Docs", url: DOCS.endpoint }, tool: "search" }));
            const legacyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", legacy))]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")
                .slice(0, 32);

            rebuiltWith(undefined, true, await origins(DOCS));

            expect(await resume({}, undefined, { [TOOL]: legacyHash })).toBe(STOP);
            deniedAsReplaced();
        });
    });

    it("runs a snapshot written before origins as before when the tool is unchanged", async () => {
        rebuiltWith("aaa", true, { [TOOL]: "other-server" });

        expect(await resume({ [TOOL]: "aaa" }, undefined, null)).toBe(STOP);
        expect(agent.approveToolCall).toHaveBeenCalledOnce();
    });

    it("runs a snapshot written before fingerprints as before when the tool is still there", async () => {
        rebuiltWith("bbb");

        expect(await resume(undefined)).toBe(STOP);
        expect(agent.approveToolCall).toHaveBeenCalledOnce();
    });
});
