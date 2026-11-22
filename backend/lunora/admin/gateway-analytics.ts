import { v } from "lunorash/server";

/**
 * Admin Gateway Analytics
 *
 * Fetches smart routing observability data from the LLM Gateway for
 * the admin panel: model breakdown, tier distribution, provider health,
 * cost trend, and aggregate overview stats.
 *
 * Requires admin role. Calls the gateway's /internal/admin/routing-analytics
 * endpoint via HMAC-authenticated GET request.
 */
import { getProviderCacheReadings, getRoutingAnalytics } from "../chat/lib/gateway-client";
import { adminAction, rateLimit } from "../lib/crpc";

const RoutingAnalyticsSchema = v.object({
    costTrend: v.array(v.object({ costMicrodollars: v.number(), date: v.string(), requestCount: v.number() })),
    modelBreakdown: v.array(
        v.object({
            avgLatencyMs: v.number(),
            costMicrodollars: v.number(),
            count: v.number(),
            errorCount: v.number(),
            modelId: v.string(),
            provider: v.string(),
        }),
    ),
    overview: v.object({
        avgLatencyMs: v.number(),
        cacheHitRate: v.number(),
        errorRate: v.number(),
        totalCostMicrodollars: v.number(),
        totalRequests: v.number(),
    }),
    period: v.union(v.literal("24h"), v.literal("7d")),
    providerHealth: v.array(
        v.object({
            avgLatency5mMs: v.number(),
            circuitBreakerUntil: v.union(v.string(), v.null()),
            errorRate5m: v.number(),
            lastFailureAt: v.union(v.string(), v.null()),
            lastSuccessAt: v.union(v.string(), v.null()),
            modelApiId: v.string(),
            provider: v.string(),
            status: v.string(),
        }),
    ),
    tierDistribution: v.array(v.object({ count: v.number(), tier: v.string() })),
});

/**
 * Fetch routing analytics from the LLM Gateway.
 * Returns model breakdown, tier distribution, provider health, cost trend,
 * and aggregate overview stats for the requested time period.
 */
export const getGatewayAnalytics = adminAction
    .use(rateLimit("admin/read"))
    // Native validator: codegen cannot read through `v.from(zod)`, so `input.period`
    // was `unknown`, and the `.default("24h")` never ran either — nothing reads the
    // zod schema at runtime. Applied in the handler.
    .input({
        period: v.optional(v.union(v.literal("24h"), v.literal("7d"))),
    })
    .output(v.from(RoutingAnalyticsSchema))
    .action(async ({ args: input, ctx }) => {
        const period = input.period ?? "24h";
        const analytics = await getRoutingAnalytics(ctx, period);

        ctx.log.event("admin.get_gateway_analytics", { period });

        return analytics;
    });

const providerCacheCountsFields = {
    cachedTokens: v.number(),
    promptTokens: v.number(),
    requests: v.number(),
};

/**
 * The provider prompt-cache readings from the gateway: prompt tokens and the share each provider served from its own
 * cache, by quarter hour (provider/model pairs that cached in the last 30 days), by model (the top 50), and for every pair in
 * the window, over the last 1, 7 or 30 days. A drop in the hourly share after a deploy shows what a prompt change cost
 * in cache reads.
 */
export const getProviderCacheReadingsForAdmin = adminAction
    .use(rateLimit("admin/read"))
    .input({ days: v.optional(v.union(v.literal(1), v.literal(7), v.literal(30))) })
    .output(
        v.object({
            all: v.object(providerCacheCountsFields),
            days: v.union(v.literal(1), v.literal(7), v.literal(30)),
            models: v.array(v.object({ ...providerCacheCountsFields, modelId: v.string(), provider: v.string() })),
            pairs: v.number(),
            quarters: v.array(v.object({ ...providerCacheCountsFields, start: v.string() })),
            since: v.string(),
        }),
    )
    .action(async ({ args, ctx }) => {
        const days = args.days ?? 7;
        const readings = await getProviderCacheReadings(ctx, days);

        ctx.log.event("admin.get_provider_cache_readings", { days });

        return readings;
    });
