/**
 * A skill's tool config goes THROUGH the permission layer: it may add tools as
 * candidates and remove tools, but a tool the user set to `off` stays off.
 *
 * MCP tools are keyed from `getMCPTools`'s descriptors, never from their
 * runtime names, so two servers whose names sanitise alike stay distinct.
 */
import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "../../_generated/server";
import { buildAgentTools } from "./agent-tools";

const fakeTool = (name: string) => ({ description: name, execute: async () => name, inputSchema: {} }) as unknown as ToolSet[string];

// The search mode's base set is `webSearch`; `additionalTools` are appended the
// way the real `getToolsForModelAndMode` does.
vi.mock("./tool-builder", () => {
    return {
        getToolsForModelAndMode: (_model: unknown, _mode: unknown, skillConfig?: { additionalTools?: string[] }) => {
            const tools: ToolSet = { webSearch: fakeTool("webSearch") };
            const additionalTools = skillConfig?.additionalTools ?? [];

            for (const name of additionalTools) {
                tools[name] = fakeTool(name);
            }

            return tools;
        },
        listBuiltInTools: () => [
            { available: true, category: "search", name: "webSearch" },
            { available: true, category: "code", name: "codeExecution" },
            { available: true, category: "code", name: "shellExecution" },
            { available: false, category: "utility", name: "wolframAlpha" },
        ],
    };
});

let mcpTools: {
    descriptors: Map<
        string,
        { annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean }; connectorSlug?: string; serverName: string; toolName: string }
    >;
    tools: ToolSet;
};

/** The servers `getMCPTools` was last asked to connect to. */
let requestedServers: { connectorSlug?: string; name: string }[] = [];

vi.mock("./mcp-tools", () => {
    return {
        getMCPTools: async (servers: { connectorSlug?: string; name: string }[]) => {
            requestedServers = servers;

            return { clients: [], errors: [], ...mcpTools };
        },
    };
});

let connectorServers: { connectorSlug: string; enabled: boolean; name: string; protocol: "http"; url: string }[] = [];

vi.mock("../../connectors/lib/grant-runtime", () => {
    return {
        getConnectorMcpServers: async () => connectorServers,
        withMcpServerGrants: async (_ctx: unknown, _userId: string, servers: unknown[]) => servers,
    };
});

let overrides: Record<string, string>;

const fakeCtx = (): ActionCtx => {
    const runQuery = vi.fn();

    // `buildAgentTools` asks for MCP servers first, then permission overrides.
    runQuery.mockResolvedValueOnce([]).mockResolvedValueOnce(overrides);

    return { runQuery } as unknown as ActionCtx;
};

const toolNames = async (skillTools?: { additionalTools?: string[]; disabledTools?: string[] }): Promise<string[]> => {
    const { tools } = await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", skillTools, userId: "user" });

    return Object.keys(tools).toSorted((a, b) => a.localeCompare(b));
};

beforeEach(() => {
    overrides = {};
    mcpTools = { descriptors: new Map(), tools: {} };
    connectorServers = [];
    requestedServers = [];
});

describe("buildAgentTools with a skill", () => {
    it("adds a skill's extra tools", async () => {
        await expect(toolNames({ additionalTools: ["codeExecution"] })).resolves.toStrictEqual(["codeExecution", "webSearch"]);
    });

    it("never enables an extra tool the user set to off", async () => {
        overrides = { "builtin:codeExecution": "off" };

        await expect(toolNames({ additionalTools: ["codeExecution", "shellExecution"] })).resolves.toStrictEqual(["shellExecution", "webSearch"]);
    });

    it("never adds an unavailable or unknown tool", async () => {
        await expect(toolNames({ additionalTools: ["wolframAlpha", "not-a-tool"] })).resolves.toStrictEqual(["webSearch"]);
    });

    it("removes a skill's disabled tools", async () => {
        await expect(toolNames({ disabledTools: ["webSearch"] })).resolves.toStrictEqual([]);
    });

    it("rebuilds a paused skill run with its extra tool, but never wider than the snapshot", async () => {
        const { tools } = await buildAgentTools(fakeCtx(), {
            model: "test-model",
            searchMode: "web",
            snapshot: { mcpServerNames: [], toolNames: ["codeExecution"] },
            userId: "user",
        });

        expect(Object.keys(tools)).toStrictEqual(["codeExecution"]);
    });
});

describe("buildAgentTools MCP permission keys", () => {
    // "my server" and "my_server" both sanitise to `my_server`; getMCPTools
    // disambiguates the runtime names and says which server each one is.
    beforeEach(() => {
        mcpTools = {
            descriptors: new Map([
                ["mcp_my_server__delete", { serverName: "my server", toolName: "delete" }],
                ["mcp_my_server__delete_2", { annotations: { readOnlyHint: true }, serverName: "my_server", toolName: "delete" }],
            ]),
            tools: { mcp_my_server__delete: fakeTool("a delete"), mcp_my_server__delete_2: fakeTool("b delete") },
        };
    });

    const build = async () => await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", userId: "user" });

    it("keys each tool by its own server, not by a guess from the runtime name", async () => {
        const { permissionKeys } = await build();

        expect(permissionKeys).toStrictEqual({
            mcp_my_server__delete: "mcp:my server:delete",
            mcp_my_server__delete_2: "mcp:my_server:delete",
            webSearch: "builtin:webSearch",
        });
    });

    it("applies an override to the one server it names", async () => {
        overrides = { "mcp:my_server:delete": "off" };

        const { permissionKeys, tools } = await build();

        expect(Object.keys(tools).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["mcp_my_server__delete", "webSearch"]);
        expect(Object.keys(permissionKeys)).not.toContain("mcp_my_server__delete_2");
    });

    it("applies each server's own annotations to its default", async () => {
        const { tools } = await build();

        expect((tools["mcp_my_server__delete"] as { needsApproval?: unknown }).needsApproval).toBe(true);
        expect((tools["mcp_my_server__delete_2"] as { needsApproval?: unknown }).needsApproval).toBeUndefined();
    });
});

describe("buildAgentTools connector tools", () => {
    beforeEach(() => {
        connectorServers = [{ connectorSlug: "notion", enabled: true, name: "Notion", protocol: "http", url: "https://mcp.notion.com/mcp" }];
        mcpTools = {
            descriptors: new Map([
                ["mcp_Notion__create_page", { connectorSlug: "notion", serverName: "Notion", toolName: "create_page" }],
                ["mcp_Notion__search", { annotations: { readOnlyHint: true }, connectorSlug: "notion", serverName: "Notion", toolName: "search" }],
            ]),
            tools: { mcp_Notion__create_page: fakeTool("create"), mcp_Notion__search: fakeTool("search") },
        };
    });

    it("connects to connected connectors alongside the user's MCP servers", async () => {
        await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", userId: "user" });

        expect(requestedServers.map((server) => server.connectorSlug)).toStrictEqual(["notion"]);
    });

    it("keys connector tools connector:<slug>:<tool>, never by the display name", async () => {
        const { permissionKeys } = await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", userId: "user" });

        expect(permissionKeys).toMatchObject({ mcp_Notion__create_page: "connector:notion:create_page", mcp_Notion__search: "connector:notion:search" });
    });

    it("defaults connector tools to ask unless they declare readOnlyHint", async () => {
        const { tools } = await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", userId: "user" });

        expect((tools["mcp_Notion__create_page"] as { needsApproval?: unknown }).needsApproval).toBe(true);
        expect((tools["mcp_Notion__search"] as { needsApproval?: unknown }).needsApproval).toBeUndefined();
    });

    it("honours an override on the connector key", async () => {
        overrides = { "connector:notion:create_page": "off" };

        const { tools } = await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", userId: "user" });

        expect(Object.keys(tools)).not.toContain("mcp_Notion__create_page");
    });

    it("rebuilds a paused run with only the connectors its snapshot named", async () => {
        await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", snapshot: { mcpServerNames: [], toolNames: [] }, userId: "user" });

        expect(requestedServers).toStrictEqual([]);

        await buildAgentTools(fakeCtx(), { model: "test-model", searchMode: "web", snapshot: { mcpServerNames: ["Notion"], toolNames: [] }, userId: "user" });

        expect(requestedServers.map((server) => server.name)).toStrictEqual(["Notion"]);
    });
});
