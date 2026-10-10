/**
 * Per-user RPM rate limiting via Cloudflare KV.
 *
 * Uses a sliding window approximation: one KV key per user per minute.
 * Tiered limits based on user tier (passed via request body or auth context).
 *
 * NOTE: KV is eventually consistent and read-then-write is non-atomic — N
 * concurrent requests can each see the same `current` and all pass the
 * check before any write lands, so a single-burst attacker can blow past
 * the configured RPM. The acceptable defenses are upstream:
 *   - Cloudflare WAF / Custom rules cap absolute QPS per IP, which
 *     bounds the burst factor regardless of this counter.
 *   - Tier-aware bucket limits in `expensiveEndpointRateLimit` keep the
 *     monetarily expensive paths low even if a user wins the race once.
 * For strict enforcement of provider-level RPM (and budget caps), the
 * counter must move to a Durable Object with `state.storage.transaction()`
 * + post-increment authoritative count.
 */
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";

const TIER_LIMITS: Record<string, number> = {
    enterprise: 600,
    free: 20,
    pro: 120,
};

const DEFAULT_RPM = 60;

export const rateLimitMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const kv = c.env.RATE_LIMIT_KV;

    // Extract user ID from request body (internal) or auth context (SaaS)
    // For internal routes, userId is in the JSON body
    const userId = c.get("userId");

    // Fail closed when KV is unbound or auth ordering invariant is broken
    // (no userId reaching the limiter). Silently no-op'ing here would let
    // a misconfigured deploy serve every request unmetered.
    if (!kv) {
        return c.json({ error: { code: "MISCONFIGURED", message: "Rate limit backend unavailable" } }, 503);
    }

    if (!userId) {
        // bearerAuth must run before this middleware. If userId is missing,
        // either the order is wrong or auth was skipped for this route.
        return c.json({ error: { code: "MISCONFIGURED", message: "Rate limit cannot identify caller" } }, 503);
    }

    const tier = c.get("userTier") ?? "free";
    const limit = TIER_LIMITS[tier] ?? DEFAULT_RPM;

    // Sliding window key: user + minute bucket
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = `rl:${userId}:${minuteBucket}`;

    const current = Number(await kv.get(key)) || 0;

    if (current >= limit) {
        const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);

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

    // Increment counter (120s TTL ensures cleanup even across minute boundaries)
    await kv.put(key, String(current + 1), { expirationTtl: 120 });

    await next();

    // Set rate limit headers AFTER next() so they attach to the actual response
    c.res.headers.set("X-RateLimit-Limit", String(limit));
    c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - current - 1)));

    return undefined;
});

/**
 * Aggressive per-user rate limit factory for expensive endpoints
 * (image / video generation, TTS / STT, embeddings batches).
 *
 * - Tier-aware ceiling: free=5, pro=30, enterprise=120 RPM (configurable
 *   via opts.tierMultiplier).
 * - IP fallback when userId is unknown so anonymous-leaning paths are
 *   still bucketed instead of unlimited.
 * - Identical sliding-window/KV semantics as the generic limiter.
 */
export const expensiveEndpointRateLimit = (options?: { bucket?: string; tierMultiplier?: number }) =>
    createMiddleware<HonoEnv>(async (c, next) => {
        const kv = c.env.RATE_LIMIT_KV;

        if (!kv) {
            await next();

            return undefined;
        }

        const bucket = options?.bucket ?? "exp";
        const userId = c.get("userId");
        const tier = c.get("userTier") ?? "free";
        const baseLimits: Record<string, number> = { enterprise: 120, free: 5, pro: 30 };
        const baseLimit = baseLimits[tier] ?? 5;
        const limit = Math.max(1, Math.floor(baseLimit * (options?.tierMultiplier ?? 1)));

        // IP fallback for paths where userId might be unset for some reason
        const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "anonymous";
        const subject = userId ?? `ip:${ip}`;

        const minuteBucket = Math.floor(Date.now() / 60_000);
        const key = `rl:${bucket}:${subject}:${minuteBucket}`;

        const current = Number(await kv.get(key)) || 0;

        if (current >= limit) {
            const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);

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

        await kv.put(key, String(current + 1), { expirationTtl: 120 });

        await next();

        c.res.headers.set("X-RateLimit-Limit", String(limit));
        c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - current - 1)));
        c.res.headers.set("X-RateLimit-Bucket", bucket);

        return undefined;
    });
