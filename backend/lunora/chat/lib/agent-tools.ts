/**
 * Builds the tool set an agent run gets: built-ins for the search mode, the
 * user's MCP tools, and the per-tool permission layer applied over both.
 *
 * Shared by the interactive run (`runStreamingAgent`) and the post-approval
 * continuation (`continueAfterToolApproval`, both in `chat/execute.ts`) so both
 * see the same tools under the same permissions — the continuation re-executes a
 * tool by name out of this set.
 */
import type { MCPClient } from "@ai-sdk/mcp";
import type { LanguageModel, ToolSet } from "ai";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { getConnectorMcpServers, withMcpServerGrants } from "../../connectors/lib/grant-runtime";
import { toolsLogger } from "../../lib/logger";
import type { DeviceToolsResult } from "./device-tools";
import { buildDeviceTools } from "./device-tools";
import type { McpToolLabels } from "./mcp-tool-labels";
import type { MCPServerConfig } from "./mcp-tools";
import { getMCPTools } from "./mcp-tools";
import type { SearchMode } from "./tool-builder";
import { getToolsForModelAndMode, listBuiltInTools } from "./tool-builder";
import type { ToolDescriptor, ToolPermissionOverrides } from "./tool-permissions";
import { applyToolPermissions, toolPermissionKey } from "./tool-permissions";

export interface BuildAgentToolsOptions {
    autoMediaEnrichment?: boolean;
    /**
     * The thread an INTERACTIVE run is in: offers the user's online devices'
     * tools (`device-tools.ts`), when that thread may reach them at all (the
     * user owns it alone). Ignored when `headless` — nobody is at the device.
     */
    deviceThreadId?: string;
    /**
     * No human is present (triggers, messenger, workflows). `ask` tools are
     * omitted instead of pausing for an approval nobody can give.
     */
    headless?: boolean;
    /** Headless only: built-ins whose `ask` the run inherited an approval for (`ToolPermissionOptions.headlessApproved`). */
    headlessApproved?: ReadonlyArray<string>;
    /** Restrict MCP servers to these names; empty/undefined means every enabled server. */
    mcpServerNames?: string[];
    model: LanguageModel | string;
    searchMode: SearchMode;
    /**
     * An invoked skill's tool config. It only changes the CANDIDATES: extra
     * tools are offered to the permission layer like any built-in, so a tool the
     * user set to `off` is removed and an `ask` tool still needs approval. A
     * skill can narrow the toolset, never widen it past the user's permissions.
     */
    skillTools?: { additionalTools?: string[]; disabledTools?: string[] };
    /**
     * Rebuild a paused run exactly (post-approval continuation). MCP servers are
     * EXACTLY these names (empty = none) and the result is narrowed to
     * `toolNames` — never wider than what the original run had.
     */
    snapshot?: { mcpServerNames: string[]; toolNames: string[] };
    userId: string;
}

export interface BuildAgentToolsResult {
    /** MUST be closed by the caller (`closeMCPClients`) once the run finishes. */
    mcpClients: MCPClient[];
    /** Runtime name -> real server and tool, for every MCP tool in `tools`. Stamped onto saved tool calls for display. */
    mcpLabels: McpToolLabels;
    /** Enabled MCP servers this run connected to — recorded in approval snapshots. */
    mcpServerNames: string[];
    /**
     * Runtime tool name -> stable permission key, for every tool in `tools`.
     * Recorded in approval snapshots so "Always allow" writes the right key
     * without re-deriving it from the runtime name.
     */
    permissionKeys: Record<string, string>;
    tools: ToolSet;
}

export const buildAgentTools = async (ctx: ActionCtx, options: BuildAgentToolsOptions): Promise<BuildAgentToolsResult> => {
    const { autoMediaEnrichment, deviceThreadId, headless, headlessApproved, mcpServerNames, model, searchMode, skillTools, snapshot, userId } = options;

    // Built-ins beyond the search mode's set: a skill's extra tools on a fresh
    // run, or — on a snapshot rebuild — every built-in the paused run had (a
    // skill's extra tool is not in the mode's set, and the narrowing below keeps
    // this from ever exceeding the snapshot). Unavailable tools are never added.
    const availableBuiltIns = new Set(listBuiltInTools().flatMap((tool) => (tool.available ? [tool.name as string] : [])));
    const extraBuiltIns = (snapshot ? snapshot.toolNames : (skillTools?.additionalTools ?? [])).filter((name) => availableBuiltIns.has(name));

    const builtInTools = getToolsForModelAndMode(model, searchMode, extraBuiltIns.length > 0 ? { additionalTools: extraBuiltIns } : undefined, {
        autoMediaEnrichment,
    });

    const [allMcpServers, overrides, connectorServers] = await Promise.all([
        ctx.runQuery(internal.auth.functions.getMCPServersQuery, { userId }),
        ctx.runQuery(internal.chat.tool_permissions.getToolPermissionsQuery, { userId }),
        // A broken connector must never take the run down with it.
        getConnectorMcpServers(ctx, userId).catch((error: unknown) => {
            toolsLogger.warn("[TOOLS] Connector servers unavailable:", error);

            return [];
        }),
    ]);

    // Bearer tokens for servers the user signed in to. The FULL list, so a grant
    // whose server was removed is recognised as orphaned and revoked.
    const servers = await withMcpServerGrants(ctx, userId, allMcpServers as MCPServerConfig[], { pruneOrphans: true }).catch((error: unknown) => {
        toolsLogger.warn("[TOOLS] MCP server sign-ins unavailable:", error);

        return allMcpServers as MCPServerConfig[];
    });
    let selectedServers = servers.filter((s) => s.enabled);

    if (snapshot) {
        selectedServers = selectedServers.filter((s) => snapshot.mcpServerNames.includes(s.name));
    } else if (mcpServerNames && mcpServerNames.length > 0) {
        selectedServers = selectedServers.filter((s) => mcpServerNames.includes(s.name));
    }

    // Connected connectors join AFTER the user's servers (a stable order, so a
    // resumed run derives the same runtime names). The composer's server pick
    // does not narrow them — their per-tool permissions do — but a snapshot does.
    selectedServers = [...selectedServers, ...(snapshot ? connectorServers.filter((s) => snapshot.mcpServerNames.includes(s.name)) : connectorServers)];

    const noDevices: DeviceToolsResult = { descriptors: new Map(), tools: {} };
    const [mcpResult, deviceResult] = await Promise.all([
        getMCPTools(selectedServers),
        // A device problem must never take the run down with it.
        deviceThreadId === undefined || headless
            ? noDevices
            : buildDeviceTools(ctx, { threadId: deviceThreadId, userId }).catch((error: unknown) => {
                  toolsLogger.warn("[TOOLS] Device tools unavailable:", error);

                  return noDevices;
              }),
    ]);

    let candidates: ToolSet = { ...builtInTools, ...mcpResult.tools, ...deviceResult.tools };

    if (snapshot) {
        const allowed = new Set(snapshot.toolNames);

        candidates = Object.fromEntries(Object.entries(candidates).filter(([name]) => allowed.has(name)));
    }

    // A skill's disabled tools cover MCP tools too, so this runs on the merged set.
    if (skillTools?.disabledTools && skillTools.disabledTools.length > 0) {
        const disabled = new Set(skillTools.disabledTools);

        candidates = Object.fromEntries(Object.entries(candidates).filter(([name]) => !disabled.has(name)));
    }

    // Keyed from where the tool came from, never parsed back out of its name.
    const describe = (runtimeName: string): ToolDescriptor | undefined => {
        const device = deviceResult.descriptors.get(runtimeName);

        if (device) {
            return { key: toolPermissionKey("device", device.toolName, device.deviceId), source: "device" };
        }

        const mcp = mcpResult.descriptors.get(runtimeName);

        if (mcp?.connectorSlug) {
            return { annotations: mcp.annotations, key: toolPermissionKey("connector", mcp.toolName, mcp.connectorSlug), source: "connector" };
        }

        return mcp && { annotations: mcp.annotations, key: toolPermissionKey("mcp", mcp.toolName, mcp.serverName), source: "mcp" };
    };

    const { removed, requiresApproval, tools } = applyToolPermissions(candidates, describe, overrides as ToolPermissionOverrides, {
        headless,
        ...(headlessApproved && { headlessApproved: new Set(headlessApproved) }),
    });

    if (removed.length > 0 || requiresApproval.length > 0) {
        toolsLogger.debug(`[TOOLS] Permissions: ${removed.length} removed, ${requiresApproval.length} require approval`, { removed, requiresApproval });
    }

    const permissionKeys = Object.fromEntries(Object.keys(tools).map((name) => [name, describe(name)?.key ?? toolPermissionKey("builtin", name)]));
    const mcpLabels: McpToolLabels = {};

    for (const name of Object.keys(tools)) {
        const mcp = mcpResult.descriptors.get(name);

        if (mcp) {
            mcpLabels[name] = { serverName: mcp.serverName, toolName: mcp.toolName };
        }

        // Shown like an MCP call, with the device's name as the "server".
        const device = deviceResult.descriptors.get(name);

        if (device) {
            mcpLabels[name] = { serverName: device.deviceName, toolName: device.toolName };
        }
    }

    return { mcpClients: mcpResult.clients, mcpLabels, mcpServerNames: selectedServers.map((s) => s.name), permissionKeys, tools };
};
