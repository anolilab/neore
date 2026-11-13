/**
 * The MCP Apps proxy (`/mcp/resource`, `/mcp/tool`) for OAuth-backed servers —
 * connectors and signed-in user servers. The browser names a server; the grant's
 * token is attached server-side and never appears in a response. A 401 gets one
 * refreshed token, and an iframe's tool call runs under the same permission the
 * model's would: `off` stays off, and `ask` is refused, since no one is there
 * to approve it.
 */
/* eslint-disable max-classes-per-file -- the two SDK classes the proxy imports, mocked side by side */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callMCPToolFromAppHttpAction, readMCPResourceHttpAction } from "./mcp-apps";
import type { MCPServerConfig } from "./mcp-tools";

const state = vi.hoisted(() => {
    return {
        acceptedToken: "fresh",
        access: [] as { connectorSlug: string; level: string }[],
        accessFails: false,
        cap: "auto" as "auto" | "ask" | "off",
        config: null as MCPServerConfig | null,
        connects: 0,
        crossed: [] as string[],
        overrides: {} as Record<string, string>,
        seenTokens: [] as string[],
        shard: "alice",
        thread: { allowed: true, mode: null } as {
            allowed: boolean;
            connectorAccess?: { connectorSlug: string; level: string }[];
            mode: string | null;
        },
        unresolved: undefined as "session" | "unavailable" | undefined,
    };
});

vi.mock("../../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "alice" };
        },
    };
});

vi.mock("./run-permission-cap", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./run-permission-cap")>()),
        readRequestPermissionCap: async () => {
            return { cap: state.cap, ...(state.unresolved && { unresolved: state.unresolved }) };
        },
    };
});

vi.mock("../../lib/thread-shard", () => {
    return { threadShardFor: async () => state.shard };
});

vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: async (_ref: unknown, _args: unknown, options: { shardKey: string }) => {
            state.crossed.push(options.shardKey);

            return { connectorAccess: [], ...state.thread };
        },
    };
});

vi.mock("../../lib/rate-limiter", () => {
    return {
        checkRateLimit: async () => {
            return { ok: true };
        },
    };
});

vi.mock("../../connectors/lib/user-mcp-servers", () => {
    return {
        findUserMcpServer: async (_ctx: unknown, userId: string, name: string) => (userId === "alice" && state.config?.name === name ? state.config : null),
        findUserMcpServerIdentity: async (_ctx: unknown, userId: string, name: string) =>
            userId === "alice" && state.config?.name === name ? { connectorSlug: state.config.connectorSlug, name: state.config.name } : null,
    };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
    return {
        StreamableHTTPClientTransport: class {
            readonly headers: Record<string, string>;

            constructor(_url: URL, options?: { requestInit?: { headers?: Record<string, string> } }) {
                this.headers = options?.requestInit?.headers ?? {};
            }
        },
    };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
    return {
        Client: class {
            private token = "";

            async callTool({ name }: { name: string }) {
                this.check();

                return { content: [{ text: `called ${name}`, type: "text" }] };
            }

            async close() {}

            async connect(transport: { headers: Record<string, string> }) {
                state.connects += 1;
                this.token = (transport.headers["Authorization"] ?? "").replace("Bearer ", "");
                state.seenTokens.push(this.token);
            }

            async listTools() {
                this.check();

                return {
                    tools: [
                        { annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, name: "search" },
                        { inputSchema: { type: "object" }, name: "create_page" },
                    ],
                };
            }

            async readResource({ uri }: { uri: string }) {
                this.check();

                return { contents: [{ mimeType: "text/html", text: "<p>app</p>", uri }] };
            }

            private check() {
                if (this.token !== state.acceptedToken) {
                    throw Object.assign(new Error("HTTP 401"), { statusCode: 401 });
                }
            }
        },
    };
});

// No session: the caller is in the personal space, which the proxy caps at auto.
const context = {
    auth: { getIdentity: async () => null },
    runQuery: async (ref: { __lunoraRef?: string }, args?: { connectorSlug?: string }) => {
        if (ref.__lunoraRef === "chat_tool_permissions:getThreadPermissionModeForApp") {
            return { connectorAccess: [], ...state.thread };
        }

        if (ref.__lunoraRef === "connectors_access:listUserConnectorAccessForSlug") {
            if (state.accessFails) {
                throw new Error("access unavailable");
            }

            return state.access
                .filter((row) => row.connectorSlug === args?.connectorSlug)
                .map((row) => {
                    return { level: row.level };
                });
        }

        return state.overrides;
    },
} as never;

const post = (body: unknown) =>
    new Request("https://backend.example.com/mcp/x", { body: JSON.stringify({ threadId: "thread-1", ...(body as object) }), method: "POST" });

// A call that names no thread: `post` always adds one, so these are sent bare.
const bare = (toolName: string) =>
    new Request("https://backend.example.com/mcp/tool", {
        body: JSON.stringify({ arguments: {}, serverName: "Notion", toolName }),
        method: "POST",
    });

const oauthConfig = (refreshTo: string | null) => {
    const oauth = { markExpired: vi.fn(async () => {}), reconnectHint: "Reconnect Notion in Settings → Connectors", refresh: vi.fn(async () => refreshTo) };

    state.config = {
        connectorSlug: "notion",
        enabled: true,
        headers: [{ key: "Authorization", value: "Bearer stale" }],
        name: "Notion",
        oauth,
        protocol: "http",
        url: "https://mcp.notion.com/mcp",
    };

    return oauth;
};

beforeEach(() => {
    state.acceptedToken = "fresh";
    state.cap = "auto";
    state.unresolved = undefined;
    state.config = null;
    state.connects = 0;
    state.crossed = [];
    state.overrides = {};
    state.shard = "alice";
    state.thread = { allowed: true, mode: null };
    state.seenTokens = [];
    state.access = [];
    state.accessFails = false;
});

describe("MCP Apps proxy with an OAuth grant", () => {
    it("reads a ui:// resource with the grant's token, refreshed once on 401, without returning it", async () => {
        const oauth = oauthConfig("fresh");
        const response = await readMCPResourceHttpAction(context, post({ serverName: "Notion", uri: "ui://notion/page" }));
        const text = await response.text();

        expect(response.status).toBe(200);
        expect(JSON.parse(text)).toMatchObject({ contents: [{ uri: "ui://notion/page" }] });
        expect(state.seenTokens).toStrictEqual(["stale", "fresh"]);
        expect(oauth.refresh).toHaveBeenCalledTimes(1);
        expect(text).not.toContain("fresh");
        expect(text).not.toContain("stale");
    });

    it("answers with the reconnect hint and marks the grant expired when the new token is refused too", async () => {
        state.acceptedToken = "never";

        const oauth = oauthConfig("fresh");
        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toStrictEqual({ error: "Reconnect Notion in Settings → Connectors" });
        expect(oauth.markExpired).toHaveBeenCalledTimes(1);
    });

    it("refuses a tool the user switched off, keyed by the connector", async () => {
        oauthConfig("fresh");
        state.overrides = { "connector:notion:create_page": "off" };

        const refused = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));
        const allowed = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(refused.status).toBe(403);
        expect(allowed.status).toBe(200);
    });

    it("refuses a tool that would need approval, since an iframe has no one to ask", async () => {
        oauthConfig("fresh");

        // Unannotated: the default is `ask`.
        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("needs your approval") });
    });

    it("says the organization's policy limits a tool its cap lowered, since changing the member's own setting would not help", async () => {
        oauthConfig("fresh");
        state.cap = "ask";
        state.overrides = { "connector:notion:create_page": "auto" };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("organization's tool policy") });
    });

    it("names the organization's policy, not the member's setting, for a tool already at ask under an ask cap", async () => {
        oauthConfig("fresh");
        state.cap = "ask";

        // Unannotated, so the member's own mode is the default `ask`; setting it to "Allow" would be held at `ask` by the cap.
        const unannotated = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        state.overrides = { "connector:notion:create_page": "ask" };

        const overridden = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        for (const response of [unannotated, overridden]) {
            expect(response.status).toBe(403);
            await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("organization's tool policy") });
        }
    });

    it("still names the member's own setting for a tool they switched off under an ask cap", async () => {
        oauthConfig("fresh");
        state.cap = "ask";
        state.overrides = { "connector:notion:create_page": "off" };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("turned off in your tool permissions") });
    });

    it("refuses every call under an off cap without contacting the server or refreshing its token", async () => {
        const oauth = oauthConfig("fresh");

        state.cap = "off";

        // No override: without the early refusal this call would connect to read the tool's annotations.
        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("organization's tool policy") });
        expect(state.connects).toBe(0);
        expect(oauth.refresh).not.toHaveBeenCalled();
    });

    it("refuses every call under an ask cap without contacting the server or refreshing its token", async () => {
        const oauth = oauthConfig("fresh");

        state.cap = "ask";

        // A read-only tool with no override would reach `auto` without the cap, so without the early refusal this call
        // would connect to read its annotations.
        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("organization's tool policy") });
        expect(state.connects).toBe(0);
        expect(oauth.refresh).not.toHaveBeenCalled();
    });

    it("asks the caller to sign in again when their session cannot be confirmed, not blaming an organization's policy", async () => {
        const oauth = oauthConfig("fresh");

        state.cap = "ask";
        state.unresolved = "session";

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));
        const { error } = (await response.json()) as { error: string };

        expect(response.status).toBe(403);
        expect(error).toContain("Sign in again");
        expect(error).not.toContain("organization");
        expect(state.connects).toBe(0);
        expect(oauth.refresh).not.toHaveBeenCalled();
    });

    it("asks the caller to retry when their tool permissions could not be read", async () => {
        oauthConfig("fresh");
        state.cap = "ask";
        state.unresolved = "unavailable";

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));
        const { error } = (await response.json()) as { error: string };

        expect(response.status).toBe(403);
        expect(error).toContain("Try again in a moment");
        expect(error).not.toContain("organization");
    });

    it("answers not found for an unknown server under a cap, as it does without one", async () => {
        oauthConfig("fresh");
        state.cap = "ask";

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Elsewhere", toolName: "search" }));

        expect(response.status).toBe(404);
    });

    it("refuses a tool the user set to ask before connecting, and runs one they allowed", async () => {
        oauthConfig("fresh");
        state.overrides = { "connector:notion:create_page": "auto", "connector:notion:search": "ask" };

        const asked = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(asked.status).toBe(403);
        expect(state.connects).toBe(0);

        const allowed = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(allowed.status).toBe(200);
        await expect(allowed.json()).resolves.toMatchObject({ content: [{ text: "called create_page" }] });
    });

    it("keys a user's own server by its name, not a connector slug", async () => {
        oauthConfig("fresh");

        if (state.config) {
            delete state.config.connectorSlug;
        }

        state.overrides = { "mcp:Notion:create_page": "auto" };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(response.status).toBe(200);
    });

    it("reads a shared thread's mode on its owner's shard and keeps the caller's server", async () => {
        oauthConfig("fresh");
        state.shard = "owner";
        state.overrides = { "connector:notion:search": "auto" };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(200);
        expect(state.crossed).toStrictEqual(["owner"]);
    });

    it("refuses a collaborator the owner's shard does not admit", async () => {
        oauthConfig("fresh");
        state.shard = "owner";
        state.thread = { allowed: false, mode: null };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(403);
    });

    it("finds only the caller's own servers", async () => {
        oauthConfig("fresh");

        const response = await readMCPResourceHttpAction(context, post({ serverName: "Someone else's", uri: "ui://x" }));

        expect(response.status).toBe(404);
    });

    it("runs a call that names no thread under the defaults, so one that would ask is refused, not rejected", async () => {
        // A client built before the thread was sent must keep working: the call is not turned away, and a tool that needs an answer
        // from a person (supervised asks for it) is refused without reaching the server.
        oauthConfig("fresh");

        const response = await callMCPToolFromAppHttpAction(
            context,
            new Request("https://backend.example.com/mcp/tool", {
                body: JSON.stringify({ arguments: {}, serverName: "Notion", toolName: "create_page" }),
                method: "POST",
            }),
        );

        expect(response.status).not.toBe(400);
        expect(JSON.stringify(await response.json())).toContain("needs your approval");
    });

    it("runs a read-only tool that names no thread, as the default does, and still refuses one that would ask", async () => {
        // The older clients: a call with no thread must not lose the read-only tools they always ran.
        oauthConfig("fresh");

        const readOnly = await callMCPToolFromAppHttpAction(context, bare("search"));
        const asks = await callMCPToolFromAppHttpAction(context, bare("create_page"));

        expect(readOnly.status).toBe(200);
        expect(asks.status).toBe(403);
    });

    it("lets an owner's app call through, reading the thread on the caller's own shard without crossing to another", async () => {
        // The route runs on the caller's shard (`onCallerShard`), which is the owner's shard for the owner's own thread: no cross-shard call.
        oauthConfig("fresh");
        state.shard = "alice";
        state.thread = { allowed: true, mode: "auto" };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(200);
        expect(state.crossed).toEqual([]);
    });

    it("refuses a thread the caller cannot reach", async () => {
        oauthConfig("fresh");
        state.thread = { allowed: false, mode: null };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(403);
    });

    it("applies a supervised thread's mode: a server's read-only hint no longer runs unasked, a tool the user allowed still does", async () => {
        oauthConfig("fresh");
        state.thread = { allowed: true, mode: "supervised" };
        state.overrides = { "connector:notion:create_page": "auto" };

        const lookup = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));
        const allowed = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(lookup.status).toBe(403);
        expect(allowed.status).toBe(200);
    });

    it("refuses every call on a connection the teammate set to none, even a tool the user allowed, before connecting", async () => {
        oauthConfig("fresh");
        state.thread = { allowed: true, connectorAccess: [{ connectorSlug: "notion", level: "none" }], mode: null };
        state.overrides = { "connector:notion:search": "auto" };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(403);
        expect(state.connects).toBe(0);
    });

    it("offers a read-only connection only the tools the server marks read only, even one the user allowed to write", async () => {
        oauthConfig("fresh");
        state.thread = { allowed: true, connectorAccess: [{ connectorSlug: "notion", level: "read_only" }], mode: null };
        state.overrides = { "connector:notion:create_page": "auto" };

        const write = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));
        const read = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(write.status).toBe(403);
        await expect(write.json()).resolves.toMatchObject({ error: expect.stringContaining("read only") });
        expect(read.status).toBe(200);
    });

    it("holds a call that names no thread to the strictest level any of the caller's teammates has on that connection", async () => {
        oauthConfig("fresh");
        state.access = [
            { connectorSlug: "notion", level: "read_write" },
            { connectorSlug: "notion", level: "read_only" },
        ];
        state.overrides = { "connector:notion:create_page": "auto" };

        const write = await callMCPToolFromAppHttpAction(context, bare("create_page"));
        const read = await callMCPToolFromAppHttpAction(context, bare("search"));

        expect(write.status).toBe(403);
        expect(read.status).toBe(200);
    });

    it("refuses a thread-less call on a connection a teammate set to none, whatever the override", async () => {
        oauthConfig("fresh");
        state.access = [{ connectorSlug: "notion", level: "none" }];
        state.overrides = { "connector:notion:search": "auto" };

        const response = await callMCPToolFromAppHttpAction(
            context,
            new Request("https://backend.example.com/mcp/tool", {
                body: JSON.stringify({ arguments: {}, serverName: "Notion", toolName: "search" }),
                method: "POST",
            }),
        );

        expect(response.status).toBe(403);
    });

    it("fails closed when the teammate's access cannot be read: the connection runs nothing", async () => {
        oauthConfig("fresh");
        state.accessFails = true;

        const response = await callMCPToolFromAppHttpAction(
            context,
            new Request("https://backend.example.com/mcp/tool", {
                body: JSON.stringify({ arguments: {}, serverName: "Notion", toolName: "search" }),
                method: "POST",
            }),
        );

        expect(response.status).toBe(403);
        expect(state.connects).toBe(0);
    });

    it("applies a shared thread's owner's connection settings, read on the owner's shard, not the caller's", async () => {
        oauthConfig("fresh");
        state.shard = "owner";
        state.thread = { allowed: true, connectorAccess: [{ connectorSlug: "notion", level: "none" }], mode: null };

        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "search" }));

        expect(response.status).toBe(403);
        expect(state.crossed).toStrictEqual(["owner"]);
    });

    it("keeps a tool that needs approval refused under full access: an iframe is not the model's turn", async () => {
        oauthConfig("fresh");
        state.thread = { allowed: true, mode: "full" };

        // Unannotated: the default is `ask`, which `full` would lift to `auto` for the model's own calls.
        const response = await callMCPToolFromAppHttpAction(context, post({ arguments: {}, serverName: "Notion", toolName: "create_page" }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("needs your approval") });
    });
});
