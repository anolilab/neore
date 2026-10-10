/**
 * GET /v1/rate-limits — Current rate-limit window status.
 *
 * Returns the authenticated user's current RPM usage and configured limit.
 * Reads from RATE_LIMIT_KV (same store as rate-limit middleware) so callers
 * can see how much of their budget has been spent before the next minute resets.
 *
 * Auth: Bearer token (gk_*) for SaaS API users.
 *       HMAC for internal/admin access (userId passed as query param).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { bearerAuth, internalAuth } from "../../middleware/auth.js";

const rateLimitsRouter = new OpenAPIHono<HonoEnv>();

const TIER_LIMITS: Record<string, { rpm: number; tpmNote: string }> = {
    enterprise: { rpm: 600, tpmNote: "TPM tracking not yet implemented" },
    free: { rpm: 20, tpmNote: "TPM tracking not yet implemented" },
    pro: { rpm: 120, tpmNote: "TPM tracking not yet implemented" },
};

const DEFAULT_RPM = 60;

const rateLimitStatusSchema = z.object({
    blocked: z.boolean(),
    blockedUntil: z.string().nullable(),
    rpm: z.object({
        current: z.number(),
        limit: z.number(),
        remaining: z.number(),
    }),
    tier: z.string(),
    userId: z.string(),
    window: z.object({
        resetsAt: z.string(),
        secondsRemaining: z.number(),
        startedAt: z.string(),
    }),
});

// ── Helper to fetch rate limit status for a user ────────────────────────────

async function getRateLimitStatus(kv: KVNamespace, userId: string, tier: string) {
    const tierConfig = TIER_LIMITS[tier] ?? { rpm: DEFAULT_RPM, tpmNote: "" };
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = `rl:${userId}:${minuteBucket}`;

    // Current minute window boundaries
    const windowStartMs = minuteBucket * 60_000;
    const windowEndMs = windowStartMs + 60_000;
    const secondsRemaining = Math.ceil((windowEndMs - Date.now()) / 1000);

    const [currentString, blockedUntilString] = await Promise.all([kv.get(key), kv.get(`blocked:${userId}`)]);

    const current = Number(currentString ?? "0");
    const isBlocked = blockedUntilString ? new Date(blockedUntilString).getTime() > Date.now() : false;

    return {
        blocked: isBlocked,
        blockedUntil: isBlocked && blockedUntilString ? blockedUntilString : null,
        rpm: {
            current,
            limit: tierConfig.rpm,
            remaining: Math.max(0, tierConfig.rpm - current),
        },
        tier,
        userId,
        window: {
            resetsAt: new Date(windowEndMs).toISOString(),
            secondsRemaining,
            startedAt: new Date(windowStartMs).toISOString(),
        },
    };
}

// ── SaaS API route (Bearer auth) ────────────────────────────────────────────

rateLimitsRouter.openapi(
    {
        method: "get",
        middleware: [bearerAuth] as const,
        path: "/v1/rate-limits",
        responses: {
            200: {
                content: { "application/json": { schema: rateLimitStatusSchema } },
                description: "Current rate-limit status for the authenticated user",
            },
        },
        summary: "Get current rate-limit window status",
        tags: ["Rate Limits"],
    },
    async (c) => {
        const userId = c.get("userId");
        const tier = c.get("userTier") ?? "free";
        const kv = c.env.RATE_LIMIT_KV;

        const status = await getRateLimitStatus(kv, userId, tier);

        return c.json(status, 200);
    },
);

// ── Internal admin route (HMAC auth, any userId) ────────────────────────────

rateLimitsRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/admin/rate-limits",
        request: {
            query: z.object({
                tier: z.string().optional().default("free"),
                userId: z.string(),
            }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: rateLimitStatusSchema } },
                description: "Rate-limit status for the specified user",
            },
        },
        summary: "Get rate-limit status for a specific user (admin)",
        tags: ["Internal"],
    },
    async (c) => {
        const { tier, userId } = c.req.valid("query");
        const kv = c.env.RATE_LIMIT_KV;

        const status = await getRateLimitStatus(kv, userId, tier);

        return c.json(status, 200);
    },
);

export { rateLimitsRouter };
