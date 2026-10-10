/**
 * Display labels for MCP tool calls.
 *
 * An MCP tool's runtime name (`mcp_<sanitised server>__<tool>`, possibly with a
 * `_2` collision suffix) cannot be parsed back into its server and tool. So once
 * a run has saved its messages, each MCP `tool-call` part is stamped with the
 * real names under `providerOptions.neore`; `toUIMessages` surfaces them on the
 * UI part's `callProviderMetadata`, and the client prefers them to parsing.
 *
 * The `neore` namespace is ours. The stamped part rides along in later prompts,
 * where no provider reads it — each reads only its own namespace.
 */

export type McpToolLabels = Record<string, { serverName: string; toolName: string }>;

/** `providerOptions.neore` on a stamped tool-call part. */
export interface NeoreToolCallOptions {
    mcpServerName: string;
    mcpToolName: string;
}

export const NEORE_PROVIDER_KEY = "neore";

interface ToolCallLike {
    providerOptions?: Record<string, Record<string, unknown>>;
    toolName?: unknown;
    type?: unknown;
}

/**
 * The content with every labelled MCP tool call stamped, or `undefined` when
 * nothing needed stamping (not an array, no MCP calls, already stamped).
 */
export const labelMcpToolCalls = (content: unknown, labels: McpToolLabels): unknown[] | undefined => {
    if (!Array.isArray(content)) {
        return undefined;
    }

    let changed = false;

    const next = content.map((part: ToolCallLike) => {
        const label = part?.type === "tool-call" && typeof part.toolName === "string" ? labels[part.toolName] : undefined;

        if (!label) {
            return part;
        }

        const current = part.providerOptions?.[NEORE_PROVIDER_KEY];

        if (current?.mcpServerName === label.serverName && current.mcpToolName === label.toolName) {
            return part;
        }

        changed = true;

        const stamped: NeoreToolCallOptions = { mcpServerName: label.serverName, mcpToolName: label.toolName };

        return { ...part, providerOptions: { ...part.providerOptions, [NEORE_PROVIDER_KEY]: { ...current, ...stamped } } };
    });

    return changed ? next : undefined;
};
