/**
 * Display labels for MCP tool calls, and the record of a call the quick check approved.
 *
 * An MCP tool's runtime name (`mcp_<sanitised server>__<tool>`, possibly with a
 * `_2` collision suffix) cannot be parsed back into its server and tool. So once
 * a run has saved its messages, each MCP `tool-call` part is stamped with the
 * real names under `providerOptions.neore`; `toUIMessages` surfaces them on the
 * UI part's `callProviderMetadata`, and the client prefers them to parsing.
 *
 * A call the user's opt-in quick check let run unasked (`low-risk-approval.ts`) is stamped the same way, by tool call
 * id, with `autoApproval: { at, by, model, reason }` — the chat shows it, and it stays on the saved call.
 *
 * The `neore` namespace is ours. The stamped part rides along in later prompts,
 * where no provider reads it — each reads only its own namespace.
 */

import type { AutoApprovalRecord } from "./low-risk-approval";

export type McpToolLabels = Record<string, { serverName: string; toolName: string }>;

/** `providerOptions.neore` on a stamped tool-call part. */
export interface NeoreToolCallOptions {
    autoApproval?: AutoApprovalRecord;
    mcpServerName?: string;
    mcpToolName?: string;
}

export const NEORE_PROVIDER_KEY = "neore";

interface ToolCallLike {
    providerOptions?: Record<string, Record<string, unknown>>;
    toolCallId?: unknown;
    toolName?: unknown;
    type?: unknown;
}

/** Calls the quick check approved, by tool call id. */
export type AutoApprovalStamps = Record<string, AutoApprovalRecord>;

/**
 * The content with every labelled MCP tool call and every auto-approved call
 * stamped, or `undefined` when nothing needed stamping (not an array, nothing to
 * stamp, already stamped).
 */
export const labelMcpToolCalls = (content: unknown, labels: McpToolLabels, autoApprovals: AutoApprovalStamps = {}): unknown[] | undefined => {
    if (!Array.isArray(content)) {
        return undefined;
    }

    let changed = false;

    const next = content.map((part: ToolCallLike) => {
        if (part?.type !== "tool-call") {
            return part;
        }

        const label = typeof part.toolName === "string" ? labels[part.toolName] : undefined;
        const approval = typeof part.toolCallId === "string" ? autoApprovals[part.toolCallId] : undefined;

        if (!label && !approval) {
            return part;
        }

        const current = part.providerOptions?.[NEORE_PROVIDER_KEY] as NeoreToolCallOptions | undefined;
        const labelled = !label || (current?.mcpServerName === label.serverName && current.mcpToolName === label.toolName);
        const approved = !approval || (current?.autoApproval?.at === approval.at && current.autoApproval.reason === approval.reason);

        if (labelled && approved) {
            return part;
        }

        changed = true;

        const stamped: NeoreToolCallOptions = {
            ...(label && { mcpServerName: label.serverName, mcpToolName: label.toolName }),
            ...(approval && { autoApproval: approval }),
        };

        return { ...part, providerOptions: { ...part.providerOptions, [NEORE_PROVIDER_KEY]: { ...current, ...stamped } } };
    });

    return changed ? next : undefined;
};
