/**
 * A bot's tool selection narrows every run's tools where they are built: a chat in the bot's thread and an unattended run for
 * the bot get the same set, a bot with no selection keeps every tool, and a selection that cannot be read leaves no tools.
 */
import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../../test/registered-api";
import { mcpServerKey } from "../../bots/tool-selectors";

// A reference is read as its dispatch key, which the fake ctx below switches on.
vi.mock("../../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const fakeTool = (name: string) => ({ description: name, execute: async () => name, inputSchema: {} }) as unknown as ToolSet[string];

vi.mock("./tool-builder", () => {
    return {
        getToolsForModelAndMode: () => {
            return { dateTime: fakeTool("dateTime"), webSearch: fakeTool("webSearch") };
        },
        listBuiltInTools: () => [],
        PULL_REQUEST_TOOLS: [],
    };
});

const DOCS_URL = "https://docs.example/mcp";
const MAIL_URL = "https://mail.example/mcp";
const DOCS = mcpServerKey(DOCS_URL) ?? "";

/** The servers each run connected to. */
const connected = vi.hoisted(() => [] as string[][]);
/** Of the user's connectors (gmail, slack), the ones each run set up: `null` when it set up every one. */
const connectorsSetUp = vi.hoisted(() => [] as (string[] | null)[]);
/** The clients each `closeMCPClients` call closed. */
const closed = vi.hoisted(() => [] as unknown[][]);
/** Per run, the names of the saved servers `withMcpServerGrants` may obtain a token for. */
const signInsUsed = vi.hoisted(() => [] as string[][]);

vi.mock("./mcp-tools", () => {
    return {
        closeMCPClients: async (clients: unknown[]) => {
            closed.push(clients);
        },
        getMCPTools: async (servers: { name: string; url: string }[]) => {
            connected.push(servers.map((server) => server.name));

            // The docs server is listed under the name the user renamed it to: its selectors still match it by address.
            const descriptors = new Map(
                [
                    ["mcp_docs__read", { endpoint: DOCS_URL, protocol: "http", serverName: "Docs (renamed)", toolName: "read", url: DOCS_URL }],
                    ["mcp_docs__search", { endpoint: DOCS_URL, protocol: "http", serverName: "Docs (renamed)", toolName: "search", url: DOCS_URL }],
                    ["mcp_mail__send", { endpoint: MAIL_URL, protocol: "http", serverName: "mail", toolName: "send", url: MAIL_URL }],
                ].filter(([, source]) => servers.some((server) => server.url === (source as { url: string }).url)) as [
                    string,
                    { endpoint: string; protocol: string; serverName: string; toolName: string; url: string },
                ][],
            );

            return {
                clients: servers.map((server) => `client:${server.name}`),
                descriptors,
                errors: [],
                tools: Object.fromEntries([...descriptors.keys()].map((name) => [name, fakeTool(name)])),
            };
        },
    };
});

vi.mock("../../connectors/lib/grant-runtime", () => {
    return {
        getConnectorMcpServers: async (_ctx: unknown, _userId: string, keep?: (slug: string) => boolean) => {
            connectorsSetUp.push(keep ? ["gmail", "slack"].filter((slug) => keep(slug)) : null);

            return [];
        },
        withMcpServerGrants: async (
            _ctx: unknown,
            _userId: string,
            servers: { name: string }[],
            options: { keep?: (server: { name: string }) => boolean } = {},
        ) => {
            signInsUsed.push(servers.filter((server) => options.keep?.(server) !== false).map((server) => server.name));

            return servers;
        },
    };
});

const { buildAgentTools } = await import("./agent-tools");
const { mcpToolOrigin } = await import("./mcp-tool-fingerprint");

/** What `bots_functions:getBotToolSelectionForRun` answers; `"fail"` throws. */
let selection: "fail" | { allow?: string[]; exclude: string[] } | null;
/** The owner of the bot `selection` belongs to, and the keys of the servers they saved. */
let botOwner: string;
let ownerServerKeys: string[];
let lookups: unknown[];
/** The organization's cap on tools (`auth_organization_policy:getPermissionCapQuery`). */
let cap: "ask" | "auto" | "off";
/** Per-tool overrides beyond the server tools' `auto`. */
let overrides: Record<string, string>;
/** Saved servers beyond docs and mail. */
let extraServers: { enabled: boolean; name: string; protocol: string; url: string }[];

const ctx = () =>
    ({
        runQuery: vi.fn(async (reference: string, args: unknown) => {
            switch (reference) {
                case "auth_functions:getMCPServersQuery": {
                    return [
                        { enabled: true, name: "Docs (renamed)", protocol: "http", url: DOCS_URL },
                        { enabled: true, name: "mail", protocol: "http", url: MAIL_URL },
                        ...extraServers,
                    ];
                }
                case "auth_organization_policy:getPermissionCapQuery": {
                    return cap;
                }
                case "bots_functions:getBotToolSelectionForRun": {
                    lookups.push(args);

                    if (selection === "fail") {
                        throw new Error("read failed");
                    }

                    return selection && { ownerId: botOwner, ownerServerKeys, selection };
                }
                case "chat_tool_permissions:getLowRiskApprovalContext": {
                    return false;
                }
                case "chat_tool_permissions:getThreadPermissionMode": {
                    return null;
                }
                // Every server tool runs unasked, so a headless run keeps it too.
                case "chat_tool_permissions:getToolPermissionsQuery": {
                    return { "mcp:Docs (renamed):read": "auto", "mcp:Docs (renamed):search": "auto", "mcp:mail:send": "auto", ...overrides };
                }
                case "source_control_pr_agent:linkedPullRequestsOfThread": {
                    return { complete: true, links: [] };
                }
                default: {
                    // The thread (no organization, so no cap) and the time grants: none.
                    return {};
                }
            }
        }),
    }) as never;

const names = (tools: ToolSet): string[] => Object.keys(tools).toSorted((a, b) => a.localeCompare(b));

const chatInBotThread = async (userId = "owner"): Promise<string[]> => {
    const { tools } = await buildAgentTools(ctx(), { model: "m", organizationId: null, searchMode: "web", threadId: "thread-1", userId });

    return names(tools);
};

const unattendedForBot = async (): Promise<string[]> => {
    const { tools } = await buildAgentTools(ctx(), {
        botLookup: { botId: "bot-1" },
        headless: true,
        model: "m",
        organizationId: null,
        searchMode: "web",
        userId: "owner",
    });

    return names(tools);
};

beforeEach(() => {
    connected.length = 0;
    closed.length = 0;
    connectorsSetUp.length = 0;
    signInsUsed.length = 0;
    extraServers = [];
    cap = "auto";
    overrides = {};
    botOwner = "owner";
    ownerServerKeys = [];
    lookups = [];
    selection = null;
});

describe("buildAgentTools with a bot's tool selection", () => {
    it("keeps every tool for a bot with no selection", async () => {
        expect(await chatInBotThread()).toStrictEqual(["dateTime", "mcp_docs__read", "mcp_docs__search", "mcp_mail__send", "webSearch"]);
        expect(lookups).toStrictEqual([{ threadId: "thread-1" }]);
    });

    it("gives a chat in the bot's thread and an unattended run for the bot the same narrowed set", async () => {
        selection = { allow: ["webSearch", `${DOCS}:*`], exclude: [`${DOCS}:read`] };

        expect(await chatInBotThread()).toStrictEqual(["mcp_docs__search", "webSearch"]);
        expect(await unattendedForBot()).toStrictEqual(["mcp_docs__search", "webSearch"]);
        expect(lookups).toStrictEqual([{ threadId: "thread-1" }, { botId: "bot-1" }]);
    });

    it("keeps a renamed server excluded: its selectors name it by address, not by name", async () => {
        selection = { exclude: [`${DOCS}:*`] };

        expect(await chatInBotThread()).toStrictEqual(["dateTime", "mcp_mail__send", "webSearch"]);
    });

    it("keeps no user server's tools once an excluded server's address was edited: which one it meant cannot be told", async () => {
        selection = { exclude: [`${mcpServerKey("https://docs.example/old-mcp") ?? ""}:*`] };

        expect(await chatInBotThread()).toStrictEqual(["dateTime", "webSearch"]);
    });

    it("narrows a collaborator's turn by the owner's selection; an owner's edited address strips only a collaborator server the owner also saved", async () => {
        // The collaborator's saved servers are docs and mail (the fake reads the same list for every user).
        botOwner = "someone-else";
        selection = { exclude: [`${mcpServerKey("https://docs.example/old-mcp") ?? ""}:*`, "dateTime"] };

        expect(await chatInBotThread("collaborator")).toStrictEqual(["mcp_docs__read", "mcp_docs__search", "mcp_mail__send", "webSearch"]);

        // The owner saved the docs address too: it may be the excluded server, moved there, so only it keeps no tools.
        ownerServerKeys = [DOCS];

        expect(await chatInBotThread("collaborator")).toStrictEqual(["mcp_mail__send", "webSearch"]);
        ownerServerKeys = [];

        // A new selection, no longer excluding dateTime: an exact key still names the collaborator's server at the same address,
        // and an allow list still keeps only what it names.
        selection = { exclude: [`${DOCS}:read`] };

        expect(await chatInBotThread("collaborator")).toStrictEqual(["dateTime", "mcp_docs__search", "mcp_mail__send", "webSearch"]);

        selection = { allow: ["webSearch", `${DOCS}:*`], exclude: [] };

        expect(await chatInBotThread("collaborator")).toStrictEqual(["mcp_docs__read", "mcp_docs__search", "webSearch"]);
    });

    it("builds every tool for a user with no selection, even with a saved address that cannot be encoded", async () => {
        extraServers = [{ enabled: true, name: "odd", protocol: "http", url: "https://odd.example/\u{D800}" }];

        expect(await chatInBotThread()).toStrictEqual(["dateTime", "mcp_docs__read", "mcp_docs__search", "mcp_mail__send", "webSearch"]);
    });

    it("connects to no server whose tools the selection could not keep", async () => {
        selection = { allow: ["webSearch"], exclude: [] };

        expect(await chatInBotThread()).toStrictEqual(["webSearch"]);

        selection = { exclude: [`${DOCS}:*`] };

        await chatInBotThread();

        expect(connected).toStrictEqual([[], ["mail"]]);
    });

    it("obtains no sign-in token for a saved server the selection could keep nothing of", async () => {
        await chatInBotThread();

        selection = { exclude: [`${DOCS}:*`] };
        await chatInBotThread();

        selection = { allow: ["webSearch"], exclude: [] };
        await chatInBotThread();

        expect(signInsUsed).toStrictEqual([["Docs (renamed)", "mail"], ["mail"], []]);
    });

    it("connects to no user server once an excluded address went stale, nor to a server whose every allowed tool is excluded", async () => {
        selection = { exclude: [`${mcpServerKey("https://docs.example/old-mcp") ?? ""}:*`] };

        await chatInBotThread();

        selection = { allow: [`${DOCS}:read`, "webSearch"], exclude: [`${DOCS}:read`] };

        expect(await chatInBotThread()).toStrictEqual(["webSearch"]);
        expect(connected).toStrictEqual([[], []]);
    });

    it("sets up only the connectors the selection could keep a tool of, and every one with no selection", async () => {
        await chatInBotThread();

        selection = { allow: [], exclude: [] };
        await chatInBotThread();

        selection = { allow: ["connector=slack:post"], exclude: [] };
        await chatInBotThread();

        selection = { exclude: ["connector=gmail:*"] };
        await chatInBotThread();

        expect(connectorsSetUp).toStrictEqual([null, [], ["slack"], ["slack"]]);
    });

    it("gives no tools for an empty allow list, and none when the selection cannot be read", async () => {
        selection = { allow: [], exclude: [] };

        expect(await unattendedForBot()).toStrictEqual([]);

        selection = "fail";

        expect(await chatInBotThread()).toStrictEqual([]);
    });

    it("records which server's tool each runtime name stood for, so an approval cannot pass to another server's tool", async () => {
        selection = { exclude: [`${DOCS}:search`] };

        const { mcpToolOrigins } = await buildAgentTools(ctx(), { model: "m", organizationId: null, searchMode: "web", threadId: "thread-1", userId: "owner" });

        expect(Object.keys(mcpToolOrigins).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["mcp_docs__read", "mcp_mail__send"]);
        expect(mcpToolOrigins.mcp_docs__read).toBe(
            await mcpToolOrigin({ endpoint: DOCS_URL, protocol: "http", serverName: "Docs (renamed)", toolName: "read" }),
        );
        expect(mcpToolOrigins.mcp_mail__send).toBe(await mcpToolOrigin({ endpoint: MAIL_URL, protocol: "http", serverName: "mail", toolName: "send" }));
    });

    it("reads no selection for a run with neither a bot nor a thread", async () => {
        selection = { allow: [], exclude: [] };

        const { tools } = await buildAgentTools(ctx(), { headless: true, model: "m", organizationId: null, searchMode: "web", userId: "owner" });

        expect(Object.keys(tools)).toHaveLength(5);
        expect(lookups).toStrictEqual([]);
    });
});

describe("buildAgentTools with a project's instruction files", () => {
    const deploy = { content: "Run the deploy script.", description: "How to deploy", id: "deploy-1", title: "Deploy" };
    const offers = async (options: Partial<Parameters<typeof buildAgentTools>[1]> = {}): Promise<boolean> => {
        const { tools } = await buildAgentTools(ctx(), {
            instructions: [deploy],
            model: "m",
            organizationId: "org-1",
            searchMode: "web",
            threadId: "thread-1",
            userId: "owner",
            ...options,
        });

        return Object.hasOwn(tools, "instruction_read");
    };

    it("offers instruction_read for listed files, and removes it as every other tool is removed", async () => {
        expect(await offers()).toBe(true);
        expect(await offers({ instructions: [] })).toBe(false);
        expect(await offers({ skillTools: { disabledTools: ["instruction_read"] } })).toBe(false);

        selection = { allow: ["webSearch"], exclude: [] };

        expect(await offers()).toBe(false);

        selection = null;
        overrides = { "builtin:instruction_read": "off" };

        expect(await offers()).toBe(false);

        overrides = {};
        cap = "off";

        expect(await offers()).toBe(false);
        expect(await offers({ headless: true })).toBe(false);
    });

    it("closes the servers it connected to when the files cannot be read, before it fails", async () => {
        await expect(offers({ instructions: Promise.reject(new Error("read failed")) })).rejects.toThrow("read failed");
        expect(closed).toStrictEqual([["client:Docs (renamed)", "client:mail"]]);
    });
});
