/**
 * What a user pastes into an MCP client to reach `POST /api/v1/mcp`.
 *
 * Pure and dependency-free so the settings page can import it. The header
 * name, scheme and path come from `identity.ts` — the constants `authenticate`
 * reads the key with — so a snippet cannot drift from what the endpoint accepts.
 */
import { API_KEY_HEADER, API_KEY_SCHEME, MCP_PATH, PUBLIC_API_PREFIX } from "./identity";

/** The name the server is registered under in the client. */
const MCP_SERVER_NAME = "neore";

export interface McpClientConfig {
    /** One-line `claude mcp add` command. */
    claudeCommand: string;
    /** The full header value, `Bearer <key>`. */
    headerValue: string;
    /** `.mcp.json`-style config: `{ mcpServers: { neore: { type: "http", url, headers } } }`. */
    json: string;
    url: string;
}

/** `origin` is the backend's public origin; a trailing slash is tolerated. */
export const buildMcpClientConfig = (origin: string, apiKey: string): McpClientConfig => {
    const url = `${origin.endsWith("/") ? origin.slice(0, -1) : origin}${PUBLIC_API_PREFIX}${MCP_PATH}`;
    const headerValue = `${API_KEY_SCHEME} ${apiKey}`;

    return {
        claudeCommand: `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "${API_KEY_HEADER}: ${headerValue}"`,
        headerValue,
        json: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { headers: { [API_KEY_HEADER]: headerValue }, type: "http", url } } }, undefined, 2),
        url,
    };
};
