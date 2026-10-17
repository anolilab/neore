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
import { getRoutingAnalytics } from "../chat/lib/gateway-client";
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
