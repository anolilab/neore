/**
 * GET /internal/admin/provider-cache — the provider prompt-cache readings (`usage/provider-cache-readings.ts`): prompt
 * tokens and the share a provider served from its cache, by hour and by model, over the last 1, 7 or 30 days.
 *
 * Served only to the backend's service binding (`internalAuth`), and the caller's adminUserId must be in the
 * GATEWAY_ADMIN_USER_IDS allowlist, like the other admin endpoints.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";
import { readProviderCacheReadings } from "../../usage/provider-cache-readings.js";
import { requireAdmin } from "./require-admin.js";

const adminProviderCacheRouter = new OpenAPIHono<HonoEnv>();

const responseSchema = z.record(z.string(), z.unknown());

adminProviderCacheRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/admin/provider-cache",
        request: {
            query: z.object({
                adminUserId: z.string().min(1),
                days: z.enum(["1", "7", "30"]).default("7"),
            }),
        },
        responses: {
            200: { content: { "application/json": { schema: responseSchema } }, description: "Readings" },
            403: { content: { "application/json": { schema: responseSchema } }, description: "Forbidden" },
        },
        summary: "Provider prompt-cache reads by hour and by model",
        tags: ["Internal"],
    },
    async (c) => {
        const { adminUserId, days } = c.req.valid("query");
        const check = requireAdmin(c.env, adminUserId);

        if (!check.ok) {
            return c.json({ error: check.reason }, 403);
        }

        const readings = await readProviderCacheReadings(c.env.USAGE_DB, Number(days) as 1 | 7 | 30, Date.now());

        return c.json(readings, 200);
    },
);

export { adminProviderCacheRouter };
