import { LunoraError, v } from "lunorash/server";

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
import { createGatewayKey, getRoutingAnalytics, listGatewayKeys, revokeGatewayKey } from "../chat/lib/gateway-client";
import { adminAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

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

// ── Key Schema ────────────────────────────────────────────────────────────────

const GatewayApiKeySchema = v.object({
    createdAt: v.string(),
    expiresAt: v.union(v.string(), v.null()),
    isActive: v.boolean(),
    keyId: v.string(),
    lastUsedAt: v.union(v.string(), v.null()),
    maxBudgetUsd: v.union(v.number(), v.null()),
    name: v.string(),
    prefix: v.string(),
    rpmLimit: v.number(),
    spentUsd: v.number(),
    tier: v.string(),
    tpmLimit: v.number(),
});

/**
 * List virtual API keys for a user (admin view).
 */
export const listGatewayKeysAction = adminAction
    .use(rateLimit("admin/read"))
    .input({
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.from(v.array(GatewayApiKeySchema)))
    .action(async ({ args: input, ctx }) => {
        const keys = await listGatewayKeys(ctx, input.userId);

        ctx.log.event("admin.list_gateway_keys", { count: keys.length });

        return keys;
    });

/**
 * Create a new virtual API key.
 */
export const createGatewayKeyAction = adminAction
    .use(rateLimit("admin/write"))
    .input({
        // Was `v.from(z.string().datetime().optional())`, which made the field
        // `unknown` to codegen — and the `.datetime()` check never ran, since
        // nothing reads the zod schema at runtime. Validated in the handler, where
        // it actually happens.
        expiresAt: v.optional(v.string().max(MAX_LENGTH.short)),
        maxBudgetUsd: v.optional(v.number()),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        orgId: v.optional(v.string().max(MAX_LENGTH.id)),
        rpmLimit: v.optional(v.number()),
        tier: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
        tpmLimit: v.optional(v.number()),
        userId: v.string().max(MAX_LENGTH.id),
    })
    // `v` has no `.extend()`, so the created-key shape — the listed key plus the
    // one-time `rawKey` — is spelled out.
    .output(
        v.from(
            v.object({
                createdAt: v.string(),
                expiresAt: v.union(v.string(), v.null()),
                isActive: v.boolean(),
                keyId: v.string(),
                lastUsedAt: v.union(v.string(), v.null()),
                maxBudgetUsd: v.union(v.number(), v.null()),
                name: v.string(),
                prefix: v.string(),
                rawKey: v.string(),
                rpmLimit: v.number(),
                spentUsd: v.number(),
                tier: v.string(),
                tpmLimit: v.number(),
            }),
        ),
    )
    .action(async ({ args: input, ctx }) => {
        if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
            throw new LunoraError("BAD_REQUEST", "`expiresAt` must be an ISO-8601 date-time");
        }

        const created = await createGatewayKey(ctx, input);

        ctx.log.event("admin.create_gateway_key", {
            hasBudget: input.maxBudgetUsd !== undefined,
            hasExpiry: input.expiresAt !== undefined,
            hasOrg: input.orgId !== undefined,
            tier: input.tier ?? "default",
        });

        return created;
    });

/**
 * Revoke a virtual API key.
 */
export const revokeGatewayKeyAction = adminAction
    .use(rateLimit("admin/write"))
    .input({
        keyId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ revoked: v.boolean() }))
    .action(async ({ args: input, ctx }) => {
        await revokeGatewayKey(ctx, input.keyId);

        ctx.log.event("admin.revoke_gateway_key", { revoked: true });

        return { revoked: true };
    });
