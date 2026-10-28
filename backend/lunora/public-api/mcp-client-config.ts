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

/** The variable the shell snippet keeps the key in. */
export const API_KEY_ENV_VAR = "NEORE_API_KEY";

export interface McpClientConfig {
    /** Two shell lines: `export` the key, then `claude mcp add` reading it from the environment, so the add command itself carries no key. */
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
        claudeCommand: [
            `export ${API_KEY_ENV_VAR}='${apiKey}'`,
            `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "${API_KEY_HEADER}: ${API_KEY_SCHEME} $${API_KEY_ENV_VAR}"`,
        ].join("\n"),
        headerValue,
        json: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { headers: { [API_KEY_HEADER]: headerValue }, type: "http", url } } }, undefined, 2),
        url,
    };
};
