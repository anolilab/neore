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
        config: null as MCPServerConfig | null,
        connects: 0,
        overrides: {} as Record<string, string>,
        seenTokens: [] as string[],
    };
});

vi.mock("../../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "alice" };
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

const context = { runQuery: async () => state.overrides } as never;

const post = (body: unknown) => new Request("https://backend.example.com/mcp/x", { body: JSON.stringify(body), method: "POST" });

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
    state.config = null;
    state.connects = 0;
    state.overrides = {};
    state.seenTokens = [];
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

    it("finds only the caller's own servers", async () => {
        oauthConfig("fresh");

        const response = await readMCPResourceHttpAction(context, post({ serverName: "Someone else's", uri: "ui://x" }));

        expect(response.status).toBe(404);
    });
});
