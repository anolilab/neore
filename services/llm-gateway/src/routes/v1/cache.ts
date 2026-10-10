/**
 * Cache management endpoints.
 *
 * GET  /v1/cache/stats  — Cache hit/miss statistics (HMAC auth)
 * DELETE /v1/cache      — Flush all cache entries (HMAC auth, admin only)
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { PromptCache } from "../../lib/prompt-cache.js";
import { internalAuth } from "../../middleware/auth.js";

const cacheRouter = new OpenAPIHono<HonoEnv>();

const statsQuerySchema = z.object({
    period: z.enum(["24h", "7d"]).optional().default("24h"),
});

const statsResponseSchema = z.object({
    hitRate: z.number(),
    hits: z.number(),
    misses: z.number(),
    period: z.string(),
    savedCostMicrodollars: z.number(),
    savedTokens: z.number(),
});

// GET /v1/cache/stats
cacheRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/v1/cache/stats",
        request: {
            query: statsQuerySchema,
        },
        responses: {
            200: {
                content: { "application/json": { schema: statsResponseSchema } },
                description: "Cache statistics",
            },
        },
        summary: "Get prompt cache hit/miss statistics",
        tags: ["Cache"],
    },
    async (c) => {
        const query = c.req.valid("query");
        const stats = await PromptCache.getStats(c.env.USAGE_DB, query.period);

        return c.json({ period: query.period, ...stats }, 200);
    },
);

// DELETE /v1/cache
cacheRouter.openapi(
    {
        method: "delete",
        middleware: [internalAuth] as const,
        path: "/v1/cache",
        request: {},
        responses: {
            200: {
                content: {
                    "application/json": {
                        schema: z.object({
                            deleted: z.number().meta({ description: "Approximate; -1 means rows are reaped lazily on next read." }),
                            epoch: z.number().meta({ description: "Unix ms timestamp of this flush. Entries with cachedAt < epoch are no longer served." }),
                            flushed: z.boolean(),
                        }),
                    },
                },
                description: "Cache flush result",
            },
        },
        summary: "Flush all prompt cache entries (admin only)",
        tags: ["Cache"],
    },
    async (c) => {
        const cache = new PromptCache(c.env.CACHE_KV);
        const result = await cache.flushAll();

        return c.json({ deleted: result.deleted, epoch: result.epoch, flushed: true }, 200);
    },
);

export { cacheRouter };
