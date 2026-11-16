/**
 * Every MCP server a user can reach, as live configs: their own saved servers
 * (with a bearer token where they signed in) followed by their connected
 * connectors. Tokens stay server-side — callers connect with these configs and
 * never return them to the browser.
 */
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import type { MCPServerConfig } from "../../chat/lib/mcp-tools";
import type { ConnectorGrant } from "./grant-runtime";
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

/**
 * Which server a name means, as {@link findUserMcpServer} would pick it, read from the stored lists alone: no sign-in
 * or connector token is resolved or refreshed. For a caller that only needs the tool's permission key.
 */
export const findUserMcpServerIdentity = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string,
    serverName: string,
): Promise<Pick<MCPServerConfig, "connectorSlug" | "name"> | null> => {
    const saved = (await ctx.runQuery(internal.auth.functions.getMCPServersQuery, { userId })) as MCPServerConfig[];

    if (saved.some((server) => server.name === serverName)) {
        return { name: serverName };
    }

    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as ConnectorGrant[];
    const grant = grants.find((candidate) => candidate.name === serverName);

    return grant ? { connectorSlug: grant.slug, name: grant.name } : null;
};
