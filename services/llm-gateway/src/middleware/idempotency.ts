/**
 * Request idempotency middleware.
 *
 * Supports `Idempotency-Key` headers on non-streaming POST /v1/chat/completions.
 * Caches the first response in KV (24h TTL) and replays it on duplicate requests.
 *
 * - Key format: `idempotency:{userId}:{idempotencyKey}` (user-scoped, no cross-user replay)
 * - Only non-streaming JSON responses are cached (streaming uses SSE, cannot be replayed)
 * - Replayed responses include `X-Idempotency-Replayed: true` header
 * - TTL is configurable via `IDEMPOTENCY_TTL_SECONDS` env var (default: 86400 = 24h)
 */
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";

const DEFAULT_TTL_SECONDS = 86_400; // 24 hours
/** Hard ceiling so a misconfigured value can't pin entries indefinitely. */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
/** Client errors a retry can still resolve — never cached. */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

const resolveTtlSeconds = (raw: string | undefined): number => {
    if (!raw) return DEFAULT_TTL_SECONDS;

    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;

    return Math.min(Math.floor(parsed), MAX_TTL_SECONDS);
};

interface CachedResponse {
    body: string;
    contentType: string;
    status: number;
}

export const idempotencyMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const idempotencyKey = c.req.header("Idempotency-Key");

    // No idempotency key — pass through
    if (!idempotencyKey) {
        await next();

        return undefined;
    }

    const userId = c.get("userId");

    // No authenticated user context — pass through (auth middleware runs before us)
    if (!userId) {
        await next();

        return undefined;
    }

    const kv = c.env.CACHE_KV;

    if (!kv) {
        await next();

        return undefined;
    }

    const cacheKey = `idempotency:${userId}:${idempotencyKey}`;

    // Check cache first
    const cached = await kv.get<CachedResponse>(cacheKey, "json");

    if (cached) {
        // Return replayed response immediately — no LLM call, no billing
        return new Response(cached.body, {
            headers: {
                "Content-Type": cached.contentType,
                "X-Idempotency-Replayed": "true",
                "X-Request-Id": c.get("requestId") ?? crypto.randomUUID(),
            },
            status: cached.status,
        });
    }

    // Cache miss — let the request through
    await next();

    // Only cache non-streaming JSON responses
    const contentType = c.res.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
        // Streaming or other response type — skip caching
        return undefined;
    }

    // Read the body from a clone so the response handed back stays intact
    const responseBody = await c.res.clone().text();
    const responseStatus = c.res.status;

    // Only cache terminal/durable responses. Skip transient failures
    // (5xx, 408, 429) so a retry can reach a healthy backend instead of
    // replaying a poisoned error indefinitely. Skip non-2xx unless the
    // 4xx is a deterministic client error that won't change on retry.
    const isSuccess = responseStatus >= 200 && responseStatus < 300;
    const isClientError = responseStatus >= 400 && responseStatus < 500;
    const isTransientClient = TRANSIENT_CLIENT_STATUSES.has(responseStatus);
    const isCacheable = isSuccess || (isClientError && !isTransientClient);

    if (!isCacheable) {
        return undefined;
    }

    // Store in KV with TTL — IDEMPOTENCY_TTL_SECONDS overrides the 24h default,
    // capped at MAX_TTL_SECONDS to prevent runaway retention.
    const ttl = resolveTtlSeconds(c.env.IDEMPOTENCY_TTL_SECONDS);
    const entry: CachedResponse = {
        body: responseBody,
        contentType,
        status: responseStatus,
    };

    // Write to KV — use waitUntil if available (Cloudflare Workers production),
    // otherwise write synchronously (test environment / local dev).
    const writePromise = kv.put(cacheKey, JSON.stringify(entry), { expirationTtl: ttl }).catch(() => {
        console.warn("[Idempotency] Failed to cache response for key:", cacheKey);
    });

    if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(writePromise);
    } else {
        await writePromise;
    }

    return undefined;
});
