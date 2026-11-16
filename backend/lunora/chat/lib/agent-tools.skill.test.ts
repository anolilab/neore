/**
 * A skill's tool config goes THROUGH the permission layer: it may add tools as
 * candidates and remove tools, but a tool the user set to `off` stays off.
 *
 * MCP tools are keyed from `getMCPTools`'s descriptors, never from their
 * runtime names, so two servers whose names sanitise alike stay distinct.
 */
import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { buildAgentTools } from "./agent-tools";
import { mcpTrustId } from "./low-risk-trust";

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
            { available: true, category: "pullRequest", name: "readPullRequest" },
            { available: true, category: "pullRequest", name: "mergePullRequest" },
            { available: true, category: "code", name: "codeExecution" },
            { available: true, category: "code", name: "shellExecution" },
            { available: false, category: "utility", name: "wolframAlpha" },
        ],
        PULL_REQUEST_TOOLS: ["readPullRequest", "mergePullRequest"],
    };
});

let mcpTools: {
    descriptors: Map<
        string,
        {
            annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
            connectorSlug?: string;
            fingerprint?: string;
            serverName: string;
            toolName: string;
            url?: string;
        }
    >;
    tools: ToolSet;
};

/** The servers `getMCPTools` was last asked to connect to. */
let requestedServers: { connectorSlug?: string; name: string }[] = [];

/** The options `getMCPTools` was last given. */
let requestedOptions: { progress?: unknown } | undefined;

vi.mock("./mcp-tools", () => {
    return {
        getMCPTools: async (servers: { connectorSlug?: string; name: string }[], options?: { progress?: unknown }) => {
            requestedServers = servers;
            requestedOptions = options;

            return { clients: [], errors: [], ...mcpTools };
        },
    };
});

let connectorServers: { connectorSlug: string; enabled: boolean; name: string; protocol: "http"; url: string }[] = [];

/** How often the connector servers were read, which refreshes their tokens. */
let connectorReads = 0;

vi.mock("../../connectors/lib/grant-runtime", () => {
    return {
        getConnectorMcpServers: async () => {
            connectorReads += 1;

            return connectorServers;
        },
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
    const { tools } = await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", skillTools, userId: "user" });

    return Object.keys(tools).toSorted((a, b) => a.localeCompare(b));
};

beforeEach(() => {
    overrides = {};
    mcpTools = { descriptors: new Map(), tools: {} };
    connectorServers = [];
    connectorReads = 0;
    requestedServers = [];
    requestedOptions = undefined;
});

describe("buildAgentTools under an ask cap", () => {
    const build = async (headless: boolean, headlessCanAsk?: boolean) => {
        const runQuery = vi.fn();

        mcpTools = {
            descriptors: new Map([["mcp_docs__search", { serverName: "docs", toolName: "search" }]]),
            tools: { mcp_docs__search: fakeTool("search") },
        };
        // MCP servers, overrides (an interactive run also reads its grants), then the run's thread, which cannot be found,
        // so the run is capped at `ask`.
        runQuery.mockResolvedValueOnce([{ enabled: true, name: "docs", protocol: "http", url: "https://docs.example/mcp" }]).mockResolvedValueOnce(overrides);

        if (!headless) {
            runQuery.mockResolvedValueOnce({});
        }

        runQuery.mockResolvedValueOnce(null).mockResolvedValue({ complete: true, links: [] });

        return await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            headless,
            ...(headlessCanAsk && { headlessCanAsk }),
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            threadId: "thread",
            userId: "user",
        });
    };

    it("gives a headless run no tools without connecting to a server or reading a connector", async () => {
        const result = await build(true);

        expect(result.tools).toStrictEqual({});
        expect(result.mcpServerNames).toStrictEqual([]);
        expect(requestedOptions).toBeUndefined();
        expect(requestedServers).toStrictEqual([]);
        expect(connectorReads).toBe(0);
    });

    it("still builds the tools of a headless run that pauses for its owner's answer, each asking", async () => {
        const result = await build(true, true);

        expect(connectorReads).toBe(1);
        expect(requestedServers.map((server) => server.name)).toStrictEqual(["docs"]);
        expect((result.tools["mcp_docs__search"] as { needsApproval?: unknown }).needsApproval).toBe(true);
    });

    it("still builds an interactive run's tools, each asking", async () => {
        const result = await build(false);

        expect(connectorReads).toBe(1);
        expect(requestedServers.map((server) => server.name)).toStrictEqual(["docs"]);
        expect((result.tools["mcp_docs__search"] as { needsApproval?: unknown }).needsApproval).toBe(true);
    });
});

describe("buildAgentTools under an organization's policy", () => {
    /** A run in a thread filed under `org-a`, whose policy sets `cap`; returns what was built and which policies were read. */
    const buildInOrganization = async (cap: "ask" | "auto" | "off", headless = false) => {
        const policiesRead: unknown[] = [];
        const runQuery = vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
            if (reference === internal.auth.functions.getMCPServersQuery) {
                return [{ enabled: true, name: "docs", protocol: "http", url: "https://docs.example/mcp" }];
            }

            if (reference === internal.chat.tool_permissions.getToolPermissionsQuery) {
                return overrides;
            }

            if (reference === internal.agent.threads.getThreadInternal) {
                return { organizationId: "org-a" };
            }

            if (reference === internal.auth.organization_policy.getPermissionCapQuery) {
                policiesRead.push(args);

                return cap;
            }

            if (reference === internal.source_control.pr_agent.linkedPullRequestsOfThread) {
                return { complete: true, links: [] };
            }

            // The thread holds no permission mode of its own, so each tool keeps its default.
            if (reference === internal.chat.tool_permissions.getThreadPermissionMode) {
                return null;
            }

            // Time grants, the quick check's eligibility and its trusted servers: none.
            return reference === internal.chat.tool_permissions.getLowRiskApprovalContext ? false : {};
        });

        mcpTools = {
            descriptors: new Map([["mcp_docs__search", { annotations: { readOnlyHint: true }, serverName: "docs", toolName: "search" }]]),
            tools: { mcp_docs__search: fakeTool("search") },
        };

        const result = await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            headless,
            model: "test-model",
            // The run was started from no organization: the thread's own is the one that caps it.
            organizationId: null,
            searchMode: "web",
            threadId: "thread",
            userId: "user",
        });

        return { policiesRead, result };
    };

    it("reads the cap from the thread's organization's policy, and offers no tool under off", async () => {
        const { policiesRead, result } = await buildInOrganization("off");

        expect(policiesRead).toStrictEqual([{ organizationId: "org-a" }]);
        expect(result.tools).toStrictEqual({});
        expect(requestedServers).toStrictEqual([]);
    });

    it("holds a read-only tool the member would run unasked at ask under that policy's ask cap", async () => {
        const { policiesRead, result } = await buildInOrganization("ask");

        expect(policiesRead).toStrictEqual([{ organizationId: "org-a" }]);
        expect((result.tools["mcp_docs__search"] as { needsApproval?: unknown }).needsApproval).toBe(true);
    });

    it("lets the same tool run unasked when the policy allows auto", async () => {
        const { result } = await buildInOrganization("auto");

        expect((result.tools["mcp_docs__search"] as { needsApproval?: unknown }).needsApproval).not.toBe(true);
    });
});

describe("buildAgentTools MCP progress", () => {
    const sink = vi.fn();

    it("hands the progress sink to the MCP tools of an interactive run", async () => {
        await buildAgentTools(fakeCtx(), { mcpProgress: sink, model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

        expect(requestedOptions?.progress).toBe(sink);
    });

    it("relays none for a run an outside agent started, whose event mapping drops progress chunks", async () => {
        await buildAgentTools(fakeCtx(), {
            mcpProgress: sink,
            model: "test-model",
            organizationId: null,
            origin: "outside_agent",
            searchMode: "web",
            userId: "user",
        });

        expect(requestedOptions?.progress).toBeUndefined();
    });
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
            organizationId: null,
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

    const build = async () => await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

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

    it("keeps an ask tool in a headless run only when the run pauses for its owner (triggers and tasks lose it)", async () => {
        const headless = async (headlessCanAsk?: boolean) =>
            await buildAgentTools(fakeCtx(), {
                headless: true,
                ...(headlessCanAsk && { headlessCanAsk }),
                model: "test-model",
                organizationId: null,
                searchMode: "web",
                userId: "user",
            });

        const unattended = await headless();

        expect(Object.keys(unattended.tools)).not.toContain("mcp_my_server__delete");

        const { tools } = await headless(true);

        expect((tools["mcp_my_server__delete"] as { needsApproval?: unknown }).needsApproval).toBe(true);
    });

    it("applies each server's own annotations to its default", async () => {
        const { tools } = await build();

        expect((tools["mcp_my_server__delete"] as { needsApproval?: unknown }).needsApproval).toBe(true);
        expect((tools["mcp_my_server__delete_2"] as { needsApproval?: unknown }).needsApproval).toBeUndefined();
    });
});

describe("buildAgentTools MCP fingerprints", () => {
    beforeEach(() => {
        mcpTools = {
            descriptors: new Map([
                ["mcp_docs__delete", { fingerprint: "bbb", serverName: "docs", toolName: "delete" }],
                // Could not be hashed: offered, but not pinned.
                ["mcp_docs__list", { serverName: "docs", toolName: "list" }],
                ["mcp_docs__search", { fingerprint: "aaa", serverName: "docs", toolName: "search" }],
            ]),
            tools: { mcp_docs__delete: fakeTool("delete"), mcp_docs__list: fakeTool("list"), mcp_docs__search: fakeTool("search") },
        };
    });

    it("records the fingerprint of each MCP tool the run is offered, and only those, for its approval snapshot", async () => {
        overrides = { "mcp:docs:delete": "off" };

        const { mcpToolFingerprints } = await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

        expect(mcpToolFingerprints).toStrictEqual({ mcp_docs__search: "aaa" });
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

    it("applies a group participant's connector access, from the thread its permissions come from", async () => {
        const runQuery = vi.fn(async (_ref: unknown, args: Record<string, unknown>) =>
            "threadId" in args ? [{ connectorSlug: "notion", level: "read_only" }] : [],
        );

        const { tools } = await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            model: "test-model",
            organizationId: null,
            permissionModeThreadId: "owner-thread",
            searchMode: "web",
            userId: "user",
        });

        expect(Object.keys(tools)).toContain("mcp_Notion__search");
        expect(Object.keys(tools)).not.toContain("mcp_Notion__create_page");
        expect(runQuery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threadId: "owner-thread" }));
    });

    it("connects to connected connectors alongside the user's MCP servers", async () => {
        await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

        expect(requestedServers.map((server) => server.connectorSlug)).toStrictEqual(["notion"]);
    });

    it("keys connector tools connector:<slug>:<tool>, never by the display name", async () => {
        const { permissionKeys } = await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

        expect(permissionKeys).toMatchObject({ mcp_Notion__create_page: "connector:notion:create_page", mcp_Notion__search: "connector:notion:search" });
    });

    it("defaults connector tools to ask unless they declare readOnlyHint", async () => {
        const { tools } = await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

        expect((tools["mcp_Notion__create_page"] as { needsApproval?: unknown }).needsApproval).toBe(true);
        expect((tools["mcp_Notion__search"] as { needsApproval?: unknown }).needsApproval).toBeUndefined();
    });

    it("honours an override on the connector key", async () => {
        overrides = { "connector:notion:create_page": "off" };

        const { tools } = await buildAgentTools(fakeCtx(), { model: "test-model", organizationId: null, searchMode: "web", userId: "user" });

        expect(Object.keys(tools)).not.toContain("mcp_Notion__create_page");
    });

    it("rebuilds a paused run with only the connectors its snapshot named", async () => {
        await buildAgentTools(fakeCtx(), {
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            snapshot: { mcpServerNames: [], toolNames: [] },
            userId: "user",
        });

        expect(requestedServers).toStrictEqual([]);

        await buildAgentTools(fakeCtx(), {
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            snapshot: { mcpServerNames: ["Notion"], toolNames: [] },
            userId: "user",
        });

        expect(requestedServers.map((server) => server.name)).toStrictEqual(["Notion"]);
    });
});

describe("buildAgentTools quick-check trust", () => {
    const URL = "https://docs.example/mcp";

    beforeEach(() => {
        mcpTools = {
            descriptors: new Map([["mcp_docs__search_docs", { serverName: "docs", toolName: "search_docs", url: URL }]]),
            tools: { mcp_docs__search_docs: fakeTool("search") },
        };
    });

    const needsApproval = async (trusted: string[], url = URL): Promise<unknown> => {
        const runQuery = vi.fn();

        // The server, override and grant reads start first; the run's thread is read next, for its permission cap.
        runQuery
            .mockResolvedValueOnce([{ enabled: true, name: "docs", protocol: "http", url }])
            .mockResolvedValueOnce(overrides)
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ organizationId: null })
            .mockResolvedValueOnce(true)
            // No pull request is linked to the thread.
            .mockResolvedValueOnce({ complete: true, links: [] })
            // The thread's permission mode.
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(trusted);

        const { tools } = await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            threadId: "thread",
            userId: "user",
        });

        return (tools["mcp_docs__search_docs"] as { needsApproval?: unknown }).needsApproval;
    };

    it("puts only a trusted server's read tool to the quick check", async () => {
        expect(typeof (await needsApproval([mcpTrustId("docs", URL)]))).toBe("function");
        expect(await needsApproval([])).toBe(true);
    });

    it("loses the trust when the server's url changed", async () => {
        mcpTools.descriptors.set("mcp_docs__search_docs", { serverName: "docs", toolName: "search_docs", url: "https://elsewhere.example/mcp" });

        expect(await needsApproval([mcpTrustId("docs", URL)], "https://elsewhere.example/mcp")).toBe(true);
    });

    it("keys each tool on its own server when two saved servers share a name", async () => {
        const [first, second] = ["https://one.example/mcp", "https://two.example/mcp"];

        mcpTools = {
            descriptors: new Map([
                ["mcp_files__read_a", { serverName: "files", toolName: "read_a", url: first }],
                ["mcp_files__read_b", { serverName: "files", toolName: "read_b", url: second }],
            ]),
            tools: { mcp_files__read_a: fakeTool("a"), mcp_files__read_b: fakeTool("b") },
        };

        const runQuery = vi.fn();

        // The server, override and grant reads start first; the run's thread is read next, for its permission cap.
        runQuery
            .mockResolvedValueOnce([
                { enabled: true, name: "files", protocol: "http", url: first },
                { enabled: true, name: "files", protocol: "http", url: second },
            ])
            .mockResolvedValueOnce(overrides)
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ organizationId: null })
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce({ complete: true, links: [] })
            // The thread's permission mode.
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce([mcpTrustId("files", second)]);

        const { tools } = await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            threadId: "thread",
            userId: "user",
        });

        expect((tools["mcp_files__read_a"] as { needsApproval?: unknown }).needsApproval).toBe(true);
        expect(typeof (tools["mcp_files__read_b"] as { needsApproval?: unknown }).needsApproval).toBe("function");
    });
});

describe("buildAgentTools pull request tools", () => {
    const toolsFor = async (linked: unknown[]): Promise<Record<string, unknown>> => {
        const runQuery = vi.fn();

        // MCP servers, overrides, grants, the run's thread (for its permission cap), the quick check's eligibility, the
        // thread's pull request links, then its permission mode.
        runQuery
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(overrides)
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ organizationId: null })
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce({ complete: true, links: linked })
            .mockResolvedValueOnce(null);

        const { tools } = await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            threadId: "thread",
            userId: "user",
        });

        return tools;
    };

    it("are offered to a thread with a linked pull request, the merge asking", async () => {
        const tools = await toolsFor([{ kind: "linked", number: 7, repository: "octo/hello" }]);

        expect(Object.keys(tools)).toStrictEqual(expect.arrayContaining(["readPullRequest", "mergePullRequest"]));
        expect((tools.mergePullRequest as { needsApproval?: unknown }).needsApproval).toBe(true);
    });

    it("cannot be added by a skill to a thread without a linked pull request", async () => {
        const runQuery = vi.fn();

        runQuery
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(overrides)
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ organizationId: null })
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce({ complete: true, links: [] })
            .mockResolvedValueOnce(null);

        const { tools } = await buildAgentTools({ runQuery } as unknown as ActionCtx, {
            model: "test-model",
            organizationId: null,
            searchMode: "web",
            skillTools: { additionalTools: ["readPullRequest", "mergePullRequest"] },
            threadId: "thread",
            userId: "user",
        });

        expect(tools.readPullRequest).toBeUndefined();
        expect(tools.mergePullRequest).toBeUndefined();
    });

    it("are not offered to a thread without one", async () => {
        const tools = await toolsFor([]);

        expect(tools.readPullRequest).toBeUndefined();
        expect(tools.mergePullRequest).toBeUndefined();
    });
});
