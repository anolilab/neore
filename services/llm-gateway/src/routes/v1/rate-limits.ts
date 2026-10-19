/**
 * GET /v1/rate-limits — Limit status for a user.
 *
 * `rpm.limit` is the tier's per-minute limit, from the same table the limiter enforces
 * (`rpmFor` in `middleware/rate-limit.ts`). `rpm.current` is always 0: the per-minute
 * count lives in the native Rate Limiting binding, which only answers allowed or not,
 * so it is not tracked here. The field stays so the response shape does not change.
 *
 * `blocked` and `blockedUntil` come from RATE_LIMIT_KV (`blocked:<userId>`, written when
 * a budget rule fires). The day's request and token counts with the caps configured for
 * the caller's tier come from `usage_log` (see `middleware/daily-limit.ts`); a `used` of
 * null means the read failed.
 *
 * Auth: Bearer token (gk_*) for SaaS API users.
 *       HMAC for internal/admin access (userId passed as query param).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { AppEnv, HonoEnv } from "../../env.js";
import { bearerAuth, internalAuth } from "../../middleware/auth.js";
import { capsFor, secondsUntilUtcMidnight, tryReadDailyUsage } from "../../middleware/daily-limit.js";
import { rpmFor } from "../../middleware/rate-limit.js";

const rateLimitsRouter = new OpenAPIHono<HonoEnv>();

const quotaSchema = z.object({
    /** The configured cap; null when the tier is uncapped. */
    limit: z.number().nullable(),
    /** Spent so far; null when the usage could not be read. */
    used: z.number().nullable(),
});

const rateLimitStatusSchema = z.object({
    blocked: z.boolean(),
    blockedUntil: z.string().nullable(),
    daily: z.object({
        requests: quotaSchema,
        resetsAt: z.string(),
        tokens: quotaSchema,
    }),
    rpm: z.object({
        current: z.number(),
        limit: z.number(),
        remaining: z.number(),
    }),
    tier: z.string(),
    tokensPerMinute: quotaSchema,
    userId: z.string(),
    window: z.object({
        resetsAt: z.string(),
        secondsRemaining: z.number(),
        startedAt: z.string(),
    }),
});

// ── Helper to fetch rate limit status for a user ────────────────────────────

async function getRateLimitStatus(env: AppEnv, userId: string, tier: string) {
    const rpm = rpmFor(tier);
    const minuteBucket = Math.floor(Date.now() / 60_000);

    // Current minute window boundaries
    const windowStartMs = minuteBucket * 60_000;
    const windowEndMs = windowStartMs + 60_000;
    const secondsRemaining = Math.ceil((windowEndMs - Date.now()) / 1000);

    const [blockedUntilString, usage] = await Promise.all([env.RATE_LIMIT_KV.get(`blocked:${userId}`), tryReadDailyUsage(env.USAGE_DB, userId)]);
    const caps = capsFor(env, tier);

    const isBlocked = blockedUntilString ? new Date(blockedUntilString).getTime() > Date.now() : false;

    return {
        blocked: isBlocked,
        blockedUntil: isBlocked && blockedUntilString ? blockedUntilString : null,
        daily: {
            requests: { limit: caps.dailyRequests, used: usage?.requests ?? null },
            resetsAt: new Date(Date.now() + secondsUntilUtcMidnight() * 1000).toISOString(),
            tokens: { limit: caps.dailyTokens, used: usage?.tokens ?? null },
        },
        // Not tracked (see the header): always 0, so the whole limit reads as remaining.
        rpm: {
            current: 0,
            limit: rpm,
            remaining: rpm,
        },
        tier,
        tokensPerMinute: { limit: caps.tokensPerMinute, used: usage?.tokensLastMinute ?? null },
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

        const status = await getRateLimitStatus(c.env, userId, tier);

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

        const status = await getRateLimitStatus(c.env, userId, tier);

        return c.json(status, 200);
    },
);

export { rateLimitsRouter };
