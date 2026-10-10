/**
 * GET /internal/admin/routing-analytics — Smart routing observability.
 *
 * Returns aggregated routing decision data for the admin panel:
 * - Overview stats (requests, cost, latency, error rate, cache hit rate)
 * - Model breakdown (requests + cost per model)
 * - Routing tier distribution (Simple/Standard/Complex/Reasoning)
 * - Provider health status (from provider_health circuit breaker table)
 * - 7-day cost trend
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";

const adminAnalyticsRouter = new OpenAPIHono<HonoEnv>();

/** Row shapes for the aggregation queries below, one per `SELECT` projection. */
interface ModelBreakdownRow {
    avg_latency_ms: number;
    cost_microdollars: number;
    count: number;
    error_count: number;
    model_id: string;
    provider: string;
}

interface TierRow {
    count: number;
    tier: string;
}

interface ProviderHealthRow {
    avg_latency_5m_ms: number;
    circuit_breaker_until: string | null;
    error_rate_5m: number;
    last_failure_at: string | null;
    last_success_at: string | null;
    model_api_id: string;
    provider: string;
    status: string;
}

interface CostTrendRow {
    cost_microdollars: number;
    date: string;
    request_count: number;
}

const periodSchema = z.enum(["24h", "7d"]).default("24h");

const routingAnalyticsResponseSchema = z.object({
    costTrend: z.array(
        z.object({
            costMicrodollars: z.number(),
            date: z.string(),
            requestCount: z.number(),
        }),
    ),
    modelBreakdown: z.array(
        z.object({
            avgLatencyMs: z.number(),
            costMicrodollars: z.number(),
            count: z.number(),
            errorCount: z.number(),
            modelId: z.string(),
            provider: z.string(),
        }),
    ),
    overview: z.object({
        avgLatencyMs: z.number(),
        cacheHitRate: z.number(),
        errorRate: z.number(),
        totalCostMicrodollars: z.number(),
        totalRequests: z.number(),
    }),
    period: z.enum(["24h", "7d"]),
    providerHealth: z.array(
        z.object({
            avgLatency5mMs: z.number(),
            circuitBreakerUntil: z.string().nullable(),
            errorRate5m: z.number(),
            lastFailureAt: z.string().nullable(),
            lastSuccessAt: z.string().nullable(),
            modelApiId: z.string(),
            provider: z.string(),
            status: z.string(),
        }),
    ),
    tierDistribution: z.array(
        z.object({
            count: z.number(),
            tier: z.string(),
        }),
    ),
});

/**
 * Defense-in-depth: even though HMAC restricts callers to those holding
 * SIGNING_SECRET, we additionally require the caller to identify the
 * requesting admin user and verify it against an env allowlist. This
 * catches accidental misuse from a non-admin backend code path.
 */
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

adminAnalyticsRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/admin/routing-analytics",
        request: {
            query: z.object({
                /** Admin user ID — verified against GATEWAY_ADMIN_USER_IDS allowlist. Part of canonical query so it's HMAC-signed. */
                adminUserId: z.string().min(1),
                period: periodSchema,
            }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: routingAnalyticsResponseSchema } },
                description: "Routing analytics",
            },
            403: {
                content: { "application/json": { schema: z.object({ error: z.string() }) } },
                description: "Caller is not an admin",
            },
        },
        summary: "Smart routing observability for admin panel",
        tags: ["Internal"],
    },
    async (c) => {
        const { adminUserId, period } = c.req.valid("query");

        const adminCheck = requireAdmin(c.env, adminUserId);

        if (!adminCheck.ok) {
            return c.json({ error: adminCheck.reason }, 403);
        }

        const database = c.env.USAGE_DB;

        // Build the time window for SQL queries
        const intervalExpression = period === "24h" ? "'-1 day'" : "'-7 days'";
        const since = `datetime('now', ${intervalExpression})`;

        // Run all queries in parallel
        const [overviewResult, modelResult, tierResult, healthResult, trendResult] = await Promise.all([
            // Overview stats
            database
                .prepare(
                    `SELECT
                        COUNT(*) as total_requests,
                        COALESCE(SUM(cost_microdollars), 0) as total_cost,
                        COALESCE(AVG(latency_ms), 0) as avg_latency,
                        COALESCE(SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END), 0) as error_count,
                        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                        COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens
                     FROM usage_log
                     WHERE created_at >= ${since}`,
                )
                .first(),

            // Model breakdown
            database
                .prepare(
                    `SELECT
                        model_id,
                        provider,
                        COUNT(*) as count,
                        COALESCE(SUM(cost_microdollars), 0) as cost_microdollars,
                        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
                        COALESCE(SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END), 0) as error_count
                     FROM usage_log
                     WHERE created_at >= ${since}
                     GROUP BY model_id, provider
                     ORDER BY count DESC
                     LIMIT 20`,
                )
                .all<ModelBreakdownRow>(),

            // Tier distribution (only rows where routing_tier was recorded)
            database
                .prepare(
                    `SELECT
                        routing_tier as tier,
                        COUNT(*) as count
                     FROM usage_log
                     WHERE routing_tier IS NOT NULL AND created_at >= ${since}
                     GROUP BY routing_tier
                     ORDER BY count DESC`,
                )
                .all<TierRow>(),

            // Provider health
            database
                .prepare(
                    `SELECT
                        provider,
                        model_api_id,
                        status,
                        error_rate_5m,
                        avg_latency_5m_ms,
                        circuit_breaker_until,
                        last_success_at,
                        last_failure_at
                     FROM provider_health
                     ORDER BY status DESC, updated_at DESC`,
                )
                .all<ProviderHealthRow>(),

            // Daily cost trend (last 7 days regardless of period — gives context)
            database
                .prepare(
                    `SELECT
                        DATE(created_at) as date,
                        COALESCE(SUM(cost_microdollars), 0) as cost_microdollars,
                        COUNT(*) as request_count
                     FROM usage_log
                     WHERE created_at >= datetime('now', '-7 days')
                     GROUP BY DATE(created_at)
                     ORDER BY date ASC`,
                )
                .all<CostTrendRow>(),
        ]);

        // Parse overview row
        const ov = overviewResult as Record<string, number> | null;
        const totalRequests = (ov?.["total_requests"] as number) ?? 0;
        const totalCostMicrodollars = (ov?.["total_cost"] as number) ?? 0;
        const avgLatencyMs = Math.round((ov?.["avg_latency"] as number) ?? 0);
        const errorCount = (ov?.["error_count"] as number) ?? 0;
        const cachedTokens = (ov?.["cached_tokens"] as number) ?? 0;
        const totalPromptTokens = (ov?.["total_prompt_tokens"] as number) ?? 0;

        const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
        const cacheHitRate = totalPromptTokens > 0 ? cachedTokens / totalPromptTokens : 0;

        // Parse model breakdown rows
        const modelBreakdown = (modelResult.results ?? []).map((row) => {
            return {
                avgLatencyMs: Math.round(Number(row["avg_latency_ms"] ?? 0)),
                costMicrodollars: Number(row["cost_microdollars"] ?? 0),
                count: Number(row["count"] ?? 0),
                errorCount: Number(row["error_count"] ?? 0),
                modelId: String(row["model_id"] ?? ""),
                provider: String(row["provider"] ?? ""),
            };
        });

        // Parse tier distribution
        const tierDistribution = (tierResult.results ?? []).map((row) => {
            return {
                count: Number(row["count"] ?? 0),
                tier: String(row["tier"] ?? ""),
            };
        });

        // Parse provider health
        const providerHealth = (healthResult.results ?? []).map((row) => {
            return {
                avgLatency5mMs: Number(row["avg_latency_5m_ms"] ?? 0),
                circuitBreakerUntil: row["circuit_breaker_until"] ? String(row["circuit_breaker_until"]) : null,
                errorRate5m: Number(row["error_rate_5m"] ?? 0),
                lastFailureAt: row["last_failure_at"] ? String(row["last_failure_at"]) : null,
                lastSuccessAt: row["last_success_at"] ? String(row["last_success_at"]) : null,
                modelApiId: String(row["model_api_id"] ?? ""),
                provider: String(row["provider"] ?? ""),
                status: String(row["status"] ?? "healthy"),
            };
        });

        // Parse cost trend
        const costTrend = (trendResult.results ?? []).map((row) => {
            return {
                costMicrodollars: Number(row["cost_microdollars"] ?? 0),
                date: String(row["date"] ?? ""),
                requestCount: Number(row["request_count"] ?? 0),
            };
        });

        return c.json(
            {
                costTrend,
                modelBreakdown,
                overview: {
                    avgLatencyMs,
                    cacheHitRate,
                    errorRate,
                    totalCostMicrodollars,
                    totalRequests,
                },
                period,
                providerHealth,
                tierDistribution,
            },
            200,
        );
    },
);

export { adminAnalyticsRouter };
