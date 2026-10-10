/**
 * GET /v1/usage — Usage dashboard data.
 *
 * Returns aggregated usage data for the authenticated user/org.
 * Phase 1d: accessible via HMAC (internal) and Bearer (SaaS) auth.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";
import { UsageAggregator } from "../../usage/aggregator.js";

const usageRouter = new OpenAPIHono<HonoEnv>();

usageRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/v1/usage",
        request: {
            query: z.object({
                period: z.string().optional().default("30"),
                userId: z.string(),
            }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Usage summary",
            },
        },
        summary: "Get usage summary",
        tags: ["Usage"],
    },
    async (c) => {
        const { period, userId } = c.req.valid("query");
        const days = Math.trunc(Number(period)) || 30;

        const aggregator = new UsageAggregator(c.env);
        const summary = await aggregator.getUserUsage(userId, days);

        return c.json(summary, 200);
    },
);

export { usageRouter };
