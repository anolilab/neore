/**
 * Admin endpoints for the cron-driven tier-pool recomputation.
 *
 * - GET  /internal/admin/tier-pools           — read current snapshot
 * - POST /internal/admin/tier-pools/recompute — force recompute now (bypass cron)
 *
 * Both require HMAC + the caller's adminUserId to appear in the
 * GATEWAY_ADMIN_USER_IDS env allowlist.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";
import { GATEWAY_MODELS } from "../../models.js";
import type { PersistedPools } from "../../routing/tier-assignment.js";
import { recomputeTierPools, TIER_POOLS_KV_KEY } from "../../routing/tier-assignment.js";

const adminTierPoolsRouter = new OpenAPIHono<HonoEnv>();

const requireAdmin = (env: { GATEWAY_ADMIN_USER_IDS?: string }, adminUserId: string | undefined): { ok: true } | { ok: false; reason: string } => {
    const allowlist = (env.GATEWAY_ADMIN_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    if (allowlist.length === 0) {
        return { ok: false, reason: "Admin endpoints are disabled (GATEWAY_ADMIN_USER_IDS not configured)" };
    }

    if (!adminUserId) {
        return { ok: false, reason: "Missing adminUserId" };
    }

    if (!allowlist.includes(adminUserId)) {
        return { ok: false, reason: "User is not in admin allowlist" };
    }

    return { ok: true };
};

const responseSchema = z.record(z.string(), z.unknown());

adminTierPoolsRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/admin/tier-pools",
        request: {
            query: z.object({
                adminUserId: z.string().min(1),
            }),
        },
        responses: {
            200: { content: { "application/json": { schema: responseSchema } }, description: "Snapshot" },
            403: { content: { "application/json": { schema: responseSchema } }, description: "Forbidden" },
            404: { content: { "application/json": { schema: responseSchema } }, description: "No snapshot yet" },
        },
        summary: "Inspect the persisted tier-pool snapshot",
        tags: ["Internal"],
    },
    async (c) => {
        const { adminUserId } = c.req.valid("query");
        const check = requireAdmin(c.env, adminUserId);

        if (!check.ok) {
            return c.json({ error: check.reason }, 403);
        }

        const snapshot = await c.env.PRICING_KV.get(TIER_POOLS_KV_KEY, "json");

        if (!snapshot) {
            return c.json({ error: "No tier-pool snapshot in KV — cron has not yet run or TTL expired" }, 404);
        }

        return c.json(snapshot as PersistedPools, 200);
    },
);

adminTierPoolsRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/admin/tier-pools/recompute",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({ adminUserId: z.string().min(1) }),
                    },
                },
            },
        },
        responses: {
            200: { content: { "application/json": { schema: responseSchema } }, description: "Recomputed snapshot" },
            403: { content: { "application/json": { schema: responseSchema } }, description: "Forbidden" },
            500: { content: { "application/json": { schema: responseSchema } }, description: "Recomputation failed" },
        },
        summary: "Force tier-pool recomputation now",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const check = requireAdmin(c.env, body.adminUserId);

        if (!check.ok) {
            return c.json({ error: check.reason }, 403);
        }

        try {
            const snapshot = await recomputeTierPools(c.env, GATEWAY_MODELS);

            return c.json(snapshot, 200);
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : "Recomputation failed" }, 500);
        }
    },
);

export { adminTierPoolsRouter };
