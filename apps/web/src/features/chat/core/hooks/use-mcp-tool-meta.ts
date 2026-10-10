"use client";

/**
 * Hook to fetch and cache MCP tool metadata (_meta.ui.resourceUri) for all
 * enabled MCP servers configured by the user.
 *
 * Returns a Map with the original server name and resourceUri for tools that
 * have an MCP App UI, keyed by `mcpToolMetaKey(serverName, toolName)` — what a
 * labelled tool part resolves to — and, for older unlabelled parts, by the
 * guessed runtime name (e.g. "mcp_Brave_Search__web_search").
 *
 * React Query deduplicates the fetch so all DefaultToolCall instances share
 * a single network request per session.
 */

import { api } from "@neore/backend/api";
import { mcpToolMetaKey } from "@neore/chat-ui/utils/mcp-tool-name";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAction } from "@/lib/lunora/crpc";

const STALE_TIME = 5 * 60 * 1000; // 5 minutes
const GC_TIME = 10 * 60 * 1000; // 10 minutes

export interface MCPToolMeta {
    resourceUri: string;
    /** Original server name from aiUserPreferences — used for Lunora proxy lookups. */
    serverName: string;
}

const useMCPToolMeta = (): Map<string, MCPToolMeta> => {
    const listMeta = useAction(api.chat.functions.listMCPToolsMeta);

    const { data } = useQuery({
        gcTime: GC_TIME,
        queryFn: () => listMeta({}),
        queryKey: ["mcp-tool-meta"],
        retry: 1,
        staleTime: STALE_TIME,
    });

    // One Map per fetched result: every message's content reads it, and a new Map
    // per render would invalidate each one.
    return useMemo(() => {
        const map = new Map<string, MCPToolMeta>();
        const servers = data?.servers ?? [];

        for (const server of servers) {
            const prefix = `mcp_${server.name.replaceAll(/[^a-z0-9]/gi, "_")}`;

            for (const tool of server.tools) {
                if (!tool.resourceUri) {
                    continue;
                }

                const meta = { resourceUri: tool.resourceUri, serverName: server.name };

                map.set(mcpToolMetaKey(server.name, tool.name), meta);
                map.set(`${prefix}__${tool.name}`, meta);
            }
        }

        return map;
    }, [data]);
};

export default useMCPToolMeta;
