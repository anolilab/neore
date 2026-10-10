import { v } from "lunorash/server";

/**
 * User-facing usage and budget alert functions.
 *
 * Surfaces LLM usage data from the gateway to users in the settings dashboard.
 * Also provides CRUD for notification rules (cost/usage threshold alerts).
 *
 * All actions call the gateway via HMAC-signed internal endpoints.
 * Auth: `authAction` — any authenticated user can view their own data.
 */
import { createNotificationRule, deleteNotificationRule, getUserUsageFromGateway, listNotificationRules } from "../chat/lib/gateway-client";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

// ── Schemas ───────────────────────────────────────────────────────────────────

const vNotificationRule = v.object({
    action: v.union(v.literal("notify"), v.literal("block"), v.literal("notify_and_block")),
    createdAt: v.string(),
    id: v.string(),
    isActive: v.boolean(),
    lastTriggeredAt: v.union(v.string(), v.null()),
    metric: v.union(v.literal("daily_cost"), v.literal("monthly_cost"), v.literal("request_count"), v.literal("token_count")),
    modelFilter: v.union(v.string(), v.null()),
    name: v.string(),
    orgId: v.union(v.string(), v.null()),
    period: v.union(v.literal("hour"), v.literal("day"), v.literal("month")),
    threshold: v.number(),
    userId: v.string(),
});

const vUserUsageSummary = v.object({
    byModel: v.record(v.string(), v.object({ cost: v.number(), requests: v.number(), tokens: v.number() })),
    dailyBreakdown: v.array(
        v.object({
            completionTokens: v.number(),
            costMicrodollars: v.number(),
            date: v.string(),
            promptTokens: v.number(),
            requestCount: v.number(),
        }),
    ),
    period: v.string(),
    totalCompletionTokens: v.number(),
    totalCostMicrodollars: v.number(),
    totalPromptTokens: v.number(),
    totalRequests: v.number(),
});

// ── Usage ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the authenticated user's LLM usage summary from the gateway.
 * Returns token counts, cost per model, and daily breakdown.
 */
/** Default window for `getMyUsage`, previously a zod `.default(30)` that never ran. */
const DEFAULT_USAGE_DAYS = 30;

export const getMyUsage = authAction
    .use(rateLimit("library/read"))
    // Native validator + explicit clamp, not `v.from(z.number()…default(30))`.
    // Codegen cannot read through the zod wrapper, so `input.days` was `unknown` —
    // and nothing read the zod schema at runtime either, so `.min(1).max(90)` and
    // the default were decoration. Both are enforced now.
    .input({
        days: v.optional(v.number()),
    })
    .output(v.from(vUserUsageSummary))
    .action(async ({ args: input, ctx }) => {
        const days = Math.min(90, Math.max(1, Math.trunc(input.days ?? DEFAULT_USAGE_DAYS)));

        const usage = await getUserUsageFromGateway(ctx, ctx.user.userId, days);

        ctx.log.event("saas.get_my_usage", { days });

        return usage;
    });

// ── Notification Rules ────────────────────────────────────────────────────────

/**
 * List all notification rules for the authenticated user.
 */
export const listMyNotificationRules = authAction
    .use(rateLimit("library/read"))
    .input({})
    .output(v.from(v.array(vNotificationRule)))
    .action(async ({ ctx }) => {
        const rules = await listNotificationRules(ctx, ctx.user.userId);

        ctx.log.event("saas.list_notification_rules", { count: rules.length });

        return rules;
    });

/**
 * Create a budget alert rule.
 */
export const createMyNotificationRule = authAction
    .use(rateLimit("notifications/update"))
    .input({
        action: v.optional(v.union(v.literal("notify"), v.literal("block"), v.literal("notify_and_block"))),
        metric: v.union(v.literal("daily_cost"), v.literal("monthly_cost"), v.literal("request_count"), v.literal("token_count")),
        modelFilter: v.optional(v.string().max(MAX_LENGTH.long)),
        name: v.string().max(MAX_LENGTH.short),
        // Same as `days` above — the zod wrapper made both `unknown`, and its
        // `.default(…)` was never applied. Defaults are applied in the handler.
        period: v.optional(v.union(v.literal("hour"), v.literal("day"), v.literal("month"))),
        threshold: v.number(),
    })
    .output(v.from(vNotificationRule))
    .action(async ({ args: input, ctx }) => {
        const rule = await createNotificationRule(ctx, {
            action: input.action ?? "notify",
            metric: input.metric,
            modelFilter: input.modelFilter,
            name: input.name,
            orgId: ctx.user.activeOrganization?.id,
            period: input.period ?? "day",
            threshold: input.threshold,
            userId: ctx.user.userId,
        });

        ctx.log.event("saas.create_my_notification_rule", { action: input.action ?? "notify", metric: input.metric, period: input.period ?? "day" });

        return rule;
    });

/**
 * Delete a budget alert rule owned by the authenticated user.
 */
export const deleteMyNotificationRule = authAction
    .use(rateLimit("notifications/update"))
    .input({
        ruleId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .action(async ({ args: input, ctx }) => {
        await deleteNotificationRule(ctx, input.ruleId, ctx.user.userId);

        ctx.log.event("saas.delete_my_notification_rule", { deleted: true });

        return null;
    });
