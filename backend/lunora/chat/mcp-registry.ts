/**
 * Browse the official MCP Registry from the settings page.
 *
 * The fetch lives in an action (outbound calls never belong in queries), is
 * memoised through `ActionCache` so repeat visits and page flips cost one D1 read
 * instead of a registry round-trip, and degrades to `{ ok: false }` rather than
 * throwing — the client then shows its curated fallback list.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { ActionCache } from "../lib/action-cache";
import { authAction, rateLimit } from "../lib/crpc";
import { logger } from "../lib/logger";
import type { McpRegistryPage } from "./lib/mcp-registry";
import { fetchRegistryPage, MAX_REGISTRY_SEARCH_LENGTH } from "./lib/mcp-registry";
import { MAX_LENGTH } from "../lib/validators";

/** The registry changes slowly; ten minutes keeps browsing snappy without going stale. */
const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;

const vMcpRegistryInput = v.object({
    choices: v.optional(v.array(v.string())),
    description: v.optional(v.string()),
    isRequired: v.boolean(),
    isSecret: v.boolean(),
    name: v.string(),
    placeholder: v.optional(v.string()),
    value: v.optional(v.string()),
});

const vMcpRegistryServer = v.object({
    description: v.string(),
    icon: v.optional(v.string()),
    id: v.string(),
    remotes: v.array(
        v.object({
            headers: v.array(vMcpRegistryInput),
            protocol: v.union(v.literal("http"), v.literal("sse")),
            url: v.string(),
            variables: v.array(vMcpRegistryInput),
        }),
    ),
    repositoryUrl: v.optional(v.string()),
    title: v.string(),
    version: v.string(),
    websiteUrl: v.optional(v.string()),
});

const vMcpRegistryPage = v.object({
    nextCursor: v.optional(v.string()),
    servers: v.array(vMcpRegistryServer),
});

/** Uncached registry fetch. Throws on failure so a failure is never cached. */
export const fetchMcpRegistryPage = internalAction
    .input({ cursor: v.union(v.string(), v.null()), search: v.union(v.string(), v.null()) })
    .output(vMcpRegistryPage)
    .action(async ({ args }) => await fetchRegistryPage({ cursor: args.cursor ?? undefined, search: args.search ?? undefined }));

/**
 * One registry page through the shared cache. The key is normalised HERE, so
 * the settings browser and the Agent Builder hit the same entries for the same
 * search. Throws when the registry is unreachable; each caller decides what
 * "unavailable" looks like.
 */
export const fetchCachedRegistryPage = async (ctx: ActionCtx, search?: string, cursor?: string): Promise<McpRegistryPage> => {
    const cache = new ActionCache<{ cursor: string | null; search: string | null }, McpRegistryPage>(undefined, {
        action: internal.chat.mcp_registry.fetchMcpRegistryPage,
        name: "mcpRegistry",
        ttl: REGISTRY_CACHE_TTL_MS,
    });

    return await cache.fetch(ctx, { cursor: cursor ?? null, search: search?.trim().toLowerCase().slice(0, MAX_REGISTRY_SEARCH_LENGTH) || null });
};

/**
 * One page of remote-capable (streamable-http / SSE) servers from the MCP
 * Registry, optionally filtered by `search`. Pass the previous page's
 * `nextCursor` to continue.
 */
export const listMcpRegistryServers = authAction
    // Search strings are free text, so every keystroke that survives the client
    // debounce is a cache miss and an outbound call.
    .use(rateLimit("mcp/registry"))
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)), search: v.optional(v.string().max(MAX_LENGTH.long)) })
    .output(
        v.union(
            v.object({ nextCursor: v.optional(v.string()), ok: v.literal(true), servers: v.array(vMcpRegistryServer) }),
            v.object({ error: v.string(), ok: v.literal(false) }),
        ),
    )
    .action(async ({ args, ctx }) => {
        try {
            const page = await fetchCachedRegistryPage(ctx, args.search, args.cursor);

            ctx.log.event("chat.list_mcp_registry_servers", { serverCount: page.servers.length });

            return { ok: true as const, ...page };
        } catch (error) {
            logger.warn("MCP registry unavailable", error);

            return { error: "The MCP registry is currently unavailable.", ok: false as const };
        }
    });
