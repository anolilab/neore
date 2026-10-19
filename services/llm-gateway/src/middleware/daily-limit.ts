/**
 * Optional per-user caps on the public chat route (`/v1/chat/completions`, and
 * `/v1/responses` through it), on top of the per-minute request limit and the
 * credit balance. All are off until configured, per tier:
 *
 *   DAILY_REQUEST_LIMITS="free=200,pro=5000"
 *   DAILY_TOKEN_LIMITS="free=100000,pro=5000000"
 *   TOKENS_PER_MINUTE_LIMITS="free=20000,pro=200000"
 *
 * A tier without an entry is uncapped. The day is the UTC day.
 *
 * The counts are read from `usage_log`, which every finished call already writes,
 * rather than from counters of their own: a KV counter takes a write per request
 * to one key, which KV rate-limits (about one write a second per key), so the
 * counter would stall under exactly the burst a cap is for. All three windows come
 * from one aggregate over the user's rows. What it costs is precision: only FINISHED
 * calls are counted (`source = 'saas_api'`, so embeddings and media calls made with
 * the same key count too), requests still in flight are not, and a call can run a
 * cap over because it is checked before the call. That is enough to stop a runaway
 * key; credits remain the billing boundary. A failed read lets the request through.
 */
import { createMiddleware } from "hono/factory";

import type { AppEnv, HonoEnv } from "../env.js";
import { logger } from "../lib/logger.js";

type TierLimits = Readonly<Record<string, number>>;

/** `"free=200,pro=5000"` → `{ free: 200, pro: 5000 }`. Entries that are not a tier and a positive integer are ignored. */
export const parseTierLimits = (raw: string | undefined): TierLimits => {
    const limits: Record<string, number> = {};
    const pairs = raw?.split(",") ?? [];

    for (const pair of pairs) {
        const [tier, value] = pair.split("=").map((part) => part.trim());
        const limit = Number(value);

        if (tier && Number.isSafeInteger(limit) && limit > 0) {
            limits[tier] = limit;
        }
    }

    return limits;
};

/** The caps configured for one tier. `null` is uncapped. */
export interface TierCaps {
    dailyRequests: number | null;
    dailyTokens: number | null;
    tokensPerMinute: number | null;
}

export const capsFor = (env: Pick<AppEnv, "DAILY_REQUEST_LIMITS" | "DAILY_TOKEN_LIMITS" | "TOKENS_PER_MINUTE_LIMITS">, tier: string): TierCaps => {
    return {
        dailyRequests: parseTierLimits(env.DAILY_REQUEST_LIMITS)[tier] ?? null,
        dailyTokens: parseTierLimits(env.DAILY_TOKEN_LIMITS)[tier] ?? null,
        tokensPerMinute: parseTierLimits(env.TOKENS_PER_MINUTE_LIMITS)[tier] ?? null,
    };
};

export const secondsUntilUtcMidnight = (now: number = Date.now()): number => {
    const next = new Date(now);

    next.setUTCHours(24, 0, 0, 0);

    return Math.ceil((next.getTime() - now) / 1000);
};

const MINUTE_MS = 60_000;

/** `usage_log.created_at` is SQLite's `datetime('now')`: UTC, `YYYY-MM-DD HH:MM:SS`. */
const sqliteTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export interface DailyUsage {
    requests: number;
    tokens: number;
    /** Prompt + completion tokens of the last 60 seconds. */
    tokensLastMinute: number;
}

/**
 * One aggregate over the user's `saas_api` rows gives the day's requests and tokens and
 * the last minute's tokens. The scan starts at the earlier of the two bounds, because
 * the minute can straddle midnight.
 */
export const readDailyUsage = async (db: D1Database, userId: string, now: number = Date.now()): Promise<DailyUsage> => {
    const dayStartMs = new Date(now).setUTCHours(0, 0, 0, 0);
    const dayStart = sqliteTime(dayStartMs);
    const minuteStartMs = now - MINUTE_MS;
    const minuteStart = sqliteTime(minuteStartMs);
    const row = await db
        .prepare(
            `SELECT COUNT(CASE WHEN created_at >= ?2 THEN 1 END) AS requests,
                    COALESCE(SUM(CASE WHEN created_at >= ?2 THEN prompt_tokens + completion_tokens END), 0) AS tokens,
                    COALESCE(SUM(CASE WHEN created_at >= ?3 THEN prompt_tokens + completion_tokens END), 0) AS tokensLastMinute
             FROM usage_log WHERE user_id = ?1 AND source = 'saas_api' AND created_at >= ?4`,
        )
        .bind(userId, dayStart, minuteStart, sqliteTime(Math.min(dayStartMs, minuteStartMs)))
        .first<{ requests: number; tokens: number; tokensLastMinute: number }>();

    return {
        requests: Number(row?.requests ?? 0),
        tokens: Number(row?.tokens ?? 0),
        tokensLastMinute: Number(row?.tokensLastMinute ?? 0),
    };
};

/**
 * The usage, or undefined when D1 cannot answer: a read that fails must not refuse a
 * request that may be within its limit. Logged, so a broken query shows up rather than
 * quietly disabling every cap.
 */
export const tryReadDailyUsage = async (db: D1Database, userId: string): Promise<DailyUsage | undefined> => {
    try {
        return await readDailyUsage(db, userId);
    } catch (error) {
        logger.error("[daily-limit] usage read failed; letting the request through", error);

        return undefined;
    }
};

const refuse = (code: string, message: string, retryAfter: number) =>
    Response.json({ error: { code, message, retryAfter } }, { headers: { "Retry-After": String(retryAfter) }, status: 429 });

/** Runs after `bearerAuth` (needs `userId` and `userTier`). */
export const dailyLimitMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const userId = c.get("userId");
    const tier = c.get("userTier") ?? "free";
    const caps = capsFor(c.env, tier);
    const isCapped = caps.dailyRequests !== null || caps.dailyTokens !== null || caps.tokensPerMinute !== null;

    if (!userId || !isCapped) {
        await next();

        return undefined;
    }

    const usage = await tryReadDailyUsage(c.env.USAGE_DB, userId);

    if (!usage) {
        await next();

        return undefined;
    }

    if (caps.dailyRequests !== null && usage.requests >= caps.dailyRequests) {
        return refuse(
            "DAILY_LIMIT_EXCEEDED",
            `Daily request limit reached: ${caps.dailyRequests} requests per day on the ${tier} tier. It resets at 00:00 UTC.`,
            secondsUntilUtcMidnight(),
        );
    }

    if (caps.dailyTokens !== null && usage.tokens >= caps.dailyTokens) {
        return refuse(
            "DAILY_LIMIT_EXCEEDED",
            `Daily token limit reached: ${caps.dailyTokens} tokens per day on the ${tier} tier. It resets at 00:00 UTC.`,
            secondsUntilUtcMidnight(),
        );
    }

    // The minute's tokens leave the window within 60 seconds, so that is the honest retry hint.
    if (caps.tokensPerMinute !== null && usage.tokensLastMinute >= caps.tokensPerMinute) {
        return refuse(
            "TOKENS_PER_MINUTE_EXCEEDED",
            `Token rate limit reached: ${caps.tokensPerMinute} tokens per minute on the ${tier} tier.`,
            MINUTE_MS / 1000,
        );
    }

    await next();

    return undefined;
});
