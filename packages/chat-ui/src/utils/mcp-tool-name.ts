import type { ToolPart } from "../types/message";

export interface McpToolName {
    serverName: string;
    toolName: string;
}

const TOOL_PREFIX_RE = /^tool-/;

/**
 * Guess server and tool from a runtime name such as `mcp_My_Server__list_files`.
 * Lossy — spaces come back from underscores and a `_2` collision suffix stays on
 * the tool — so only for parts saved before the backend labelled MCP calls.
 */
const parseMcpRuntimeName = (runtimeName: string): McpToolName | null => {
    if (!runtimeName.startsWith("mcp_")) {
        return null;
    }

    const separator = runtimeName.indexOf("__", 4);

    if (separator === -1) {
        return null;
    }

    const serverName = runtimeName.slice(4, separator).replaceAll("_", " ").trim();
    const toolName = runtimeName.slice(separator + 2);

    return serverName && toolName ? { serverName, toolName } : null;
};

/**
 * The real server and tool behind an MCP tool part, or `null` for any other
 * tool. Prefers the names the backend stamped on the call
 * (`callProviderMetadata.neore`); falls back to parsing the runtime name.
 */
export const resolveMcpToolName = (part: Pick<ToolPart, "callProviderMetadata" | "type">): McpToolName | null => {
    const label = part.callProviderMetadata?.neore;

    if (typeof label?.mcpServerName === "string" && typeof label.mcpToolName === "string") {
        return { serverName: label.mcpServerName, toolName: label.mcpToolName };
    }

    return parseMcpRuntimeName(part.type.replace(TOOL_PREFIX_RE, ""));
};

/** Key for MCP tool metadata by real server and tool name — immune to runtime-name collisions. */
export const mcpToolMetaKey = (serverName: string, toolName: string): string => `${serverName}\u{0}${toolName}`;
