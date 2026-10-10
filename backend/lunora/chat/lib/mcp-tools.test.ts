/**
 * `getMCPTools` names every MCP tool and records where it came from. Sanitising
 * a server name is lossy, so two servers can produce the same runtime name; the
 * descriptors — not the name — are what identify the tool.
 */
import { describe, expect, it, vi } from "vitest";

import { getMCPTools, mcpRuntimeToolName } from "./mcp-tools";
import type { MCPServerConfig } from "./mcp-tools";

// One fake client per server URL; `tools()` returns that server's tools.
const SERVER_TOOLS: Record<string, Record<string, unknown>> = {
    "https://a.example/mcp": { delete: { description: "a delete", metadata: { annotations: { destructiveHint: true } } } },
    "https://b.example/mcp": { delete: { description: "b delete", metadata: { annotations: { readOnlyHint: true } } }, list: { description: "b list" } },
};

const OAUTH_URL = "https://oauth.example/mcp";

vi.mock("@ai-sdk/mcp", () => {
    return {
        createMCPClient: async ({ transport }: { transport: { headers?: Record<string, string>; url: string } }) => {
            return {
                close: async () => {},
                tools: async () => {
                    // The OAuth server accepts only the refreshed token.
                    if (transport.url === OAUTH_URL && transport.headers?.["Authorization"] !== "Bearer fresh") {
                        throw Object.assign(new Error("HTTP 401"), { statusCode: 401 });
                    }

                    return transport.url === OAUTH_URL ? { search: { description: "search" } } : (SERVER_TOOLS[transport.url] ?? {});
                },
            };
        },
    };
});

const server = (name: string, url: string): MCPServerConfig => {
    return { enabled: true, name, protocol: "http", url };
};

describe("mcpRuntimeToolName", () => {
    it("prefixes the sanitised server name", () => {
        expect(mcpRuntimeToolName("My Server", "list_files")).toBe("mcp_My_Server__list_files");
    });

    it("suffixes a name that is already taken, deterministically", () => {
        const taken = new Set(["mcp_my_server__x", "mcp_my_server__x_2"]);

        expect(mcpRuntimeToolName("my server", "x", taken)).toBe("mcp_my_server__x_3");
    });
});

describe("getMCPTools", () => {
    it("keeps colliding sanitised names apart and records each tool's real server", async () => {
        const result = await getMCPTools([server("my server", "https://a.example/mcp"), server("my_server", "https://b.example/mcp")]);

        expect(Object.keys(result.tools)).toStrictEqual(["mcp_my_server__delete", "mcp_my_server__delete_2", "mcp_my_server__list"]);
        expect(Object.fromEntries(result.descriptors)).toStrictEqual({
            mcp_my_server__delete: { annotations: { destructiveHint: true }, serverName: "my server", toolName: "delete" },
            mcp_my_server__delete_2: { annotations: { readOnlyHint: true }, serverName: "my_server", toolName: "delete" },
            mcp_my_server__list: { serverName: "my_server", toolName: "list" },
        });
        expect((result.tools["mcp_my_server__delete_2"] as { description?: string }).description).toBe("b delete");
    });

    it("names the same servers the same way on a rebuild", async () => {
        const servers = [server("my server", "https://a.example/mcp"), server("my_server", "https://b.example/mcp")];
        const first = await getMCPTools(servers);
        const second = await getMCPTools(servers);

        expect([...second.descriptors]).toStrictEqual([...first.descriptors]);
    });
});

describe("getMCPTools with an OAuth-backed server", () => {
    const oauthServer = (token: string | null) => {
        const oauth = { markExpired: vi.fn(async () => {}), reconnectHint: "Reconnect Notion in Settings → Connectors", refresh: vi.fn(async () => token) };

        return {
            oauth,
            server: { ...server("Notion", OAUTH_URL), headers: [{ key: "Authorization", value: "Bearer stale" }], oauth } satisfies MCPServerConfig,
        };
    };

    it("refreshes once when discovery answers 401, and connects with the new token", async () => {
        const { oauth, server: config } = oauthServer("fresh");
        const result = await getMCPTools([config]);

        expect(Object.keys(result.tools)).toStrictEqual(["mcp_Notion__search"]);
        expect(oauth.refresh).toHaveBeenCalledTimes(1);
    });

    it("drops the server when no token can be had", async () => {
        const { oauth, server: config } = oauthServer(null);
        const result = await getMCPTools([config]);

        expect(result.tools).toStrictEqual({});
        expect(result.errors).toHaveLength(1);
        expect(oauth.markExpired).not.toHaveBeenCalled();
    });
});
