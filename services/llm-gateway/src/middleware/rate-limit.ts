/**
 * Per-user RPM rate limiting on the native Rate Limiting bindings
 * (`native-rate-limit.ts`). Tiered limits come from the user tier.
 *
 * Both limiters fail closed: a missing binding answers 503, the same as an
 * unbound KV namespace did before.
 */
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";
import type { RateLimitValue } from "./native-rate-limit.js";
import { consumeRateLimit, RATE_LIMIT_VALUES, secondsUntilNextMinute } from "./native-rate-limit.js";

const TIER_LIMITS: Record<string, number> = {
    enterprise: 600,
    free: 20,
    pro: 120,
};

const DEFAULT_RPM = 60;

const misconfigured = (c: Context<HonoEnv>, message: string) => c.json({ error: { code: "MISCONFIGURED", message } }, 503);

export const rateLimitMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    // Extract user ID from request body (internal) or auth context (SaaS)
    // For internal routes, userId is in the JSON body
    const userId = c.get("userId");

    // Fail closed when the limiter is unbound or auth ordering invariant is broken
    // (no userId reaching the limiter). Silently no-op'ing here would let
    // a misconfigured deploy serve every request unmetered.
    if (!userId) {
        // bearerAuth must run before this middleware. If userId is missing,
        // either the order is wrong or auth was skipped for this route.
        return misconfigured(c, "Rate limit cannot identify caller");
    }

    const tier = c.get("userTier") ?? "free";
    const limit = TIER_LIMITS[tier] ?? DEFAULT_RPM;
    const allowed = await consumeRateLimit(c.env, limit, `chat:${userId}`);

    if (allowed === null) {
        return misconfigured(c, "Rate limit backend unavailable");
    }

    if (!allowed) {
        const retryAfter = secondsUntilNextMinute();

        return c.json(
            {
                error: {
                    code: "RATE_LIMITED",
                    message: `Rate limit exceeded: ${limit} requests per minute`,
                    retryAfter,
                },
            },
            {
                headers: {
                    "Retry-After": String(retryAfter),
                    "X-RateLimit-Limit": String(limit),
                    "X-RateLimit-Remaining": "0",
                },
                status: 429,
            },
        );
    }

    await next();

    // The native binding does not report a remaining count, so only the limit is set.
    c.res.headers.set("X-RateLimit-Limit", String(limit));

    return undefined;
});

/**
 * Aggressive per-user rate limit factory for expensive endpoints
 * (image / video generation, TTS / STT, embeddings batches).
 *
 * - Tier-aware ceiling: free=5, pro=30, enterprise=120 RPM (configurable
 *   via opts.tierMultiplier, floored, so 0.5 gives free=2, pro=15, enterprise=60).
 * - IP fallback when userId is unknown so anonymous-leaning paths are
 *   still bucketed instead of unlimited.
 */
const TIER_BASE_LIMITS: Record<string, number> = { enterprise: 120, free: 5, pro: 30 };

/**
 * Throws when a tier's limit under `multiplier` has no native binding. Such a
 * limit would answer 503 on every request, so the factory refuses it up front.
 */
const assertBoundLimits = (multiplier: number): void => {
    for (const base of Object.values(TIER_BASE_LIMITS)) {
        const limit = Math.max(1, Math.floor(base * multiplier));

        if (!RATE_LIMIT_VALUES.includes(limit as RateLimitValue)) {
            throw new Error(`tierMultiplier ${multiplier} gives ${limit} RPM, which has no native rate-limit binding (${RATE_LIMIT_VALUES.join(", ")})`);
        }
    }
};

export const expensiveEndpointRateLimit = (options?: { bucket?: string; tierMultiplier?: number }) => {
    const multiplier = options?.tierMultiplier ?? 1;

    assertBoundLimits(multiplier);

    return createMiddleware<HonoEnv>(async (c, next) => {
        const bucket = options?.bucket ?? "exp";
        const userId = c.get("userId");
        const tier = c.get("userTier") ?? "free";
        const baseLimit = TIER_BASE_LIMITS[tier] ?? 5;
        const limit = Math.max(1, Math.floor(baseLimit * multiplier));

        // IP fallback for paths where userId might be unset for some reason
        const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "anonymous";
        const subject = userId ?? `ip:${ip}`;
        const allowed = await consumeRateLimit(c.env, limit, `${bucket}:${subject}`);

        if (allowed === null) {
            return misconfigured(c, "Rate limit backend unavailable");
        }

        if (!allowed) {
            const retryAfter = secondsUntilNextMinute();

            return c.json(
                {
                    error: {
                        code: "RATE_LIMITED",
                        message: `Rate limit exceeded for ${bucket}: ${limit} requests per minute`,
                        retryAfter,
                    },
                },
                {
                    headers: {
                        "Retry-After": String(retryAfter),
                        "X-RateLimit-Bucket": bucket,
                        "X-RateLimit-Limit": String(limit),
                        "X-RateLimit-Remaining": "0",
                    },
                    status: 429,
                },
            );
        }

        await next();

        c.res.headers.set("X-RateLimit-Limit", String(limit));
        c.res.headers.set("X-RateLimit-Bucket", bucket);

        return undefined;
    });
};
