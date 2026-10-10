/**
 * Every MCP server a user can reach, as live configs: their own saved servers
 * (with a bearer token where they signed in) followed by their connected
 * connectors. Tokens stay server-side — callers connect with these configs and
 * never return them to the browser.
 */
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import type { MCPServerConfig } from "../../chat/lib/mcp-tools";
import { getConnectorMcpServers, withMcpServerGrants } from "./grant-runtime";

export const resolveUserMcpServers = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string): Promise<MCPServerConfig[]> => {
    const saved = (await ctx.runQuery(internal.auth.functions.getMCPServersQuery, { userId })) as MCPServerConfig[];
    const [signedIn, connectors] = await Promise.all([
        withMcpServerGrants(ctx, userId, saved).catch(() => saved),
        getConnectorMcpServers(ctx, userId).catch((): MCPServerConfig[] => []),
    ]);

    return [...signedIn, ...connectors];
};

/**
 * One server by the name the chat recorded for a tool (`mcpLabels.serverName`).
 * The user's own server wins a name clash, as it does in the agent's tool set.
 */
export const findUserMcpServer = async (
    ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
    userId: string,
    serverName: string,
): Promise<MCPServerConfig | null> => {
    const servers = await resolveUserMcpServers(ctx, userId);

    return servers.find((server) => server.name === serverName) ?? null;
};
