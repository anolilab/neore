/**
 * POST /internal/route — Smart model selection.
 *
 * Called by the backend before /internal/stream to determine the best model
 * for a given query. Scores the query across multiple dimensions and
 * selects the most cost-effective model that meets quality requirements.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";
import { GATEWAY_MODELS } from "../../models.js";
import { ProviderHealthService } from "../../providers/health.js";
import { PricingService } from "../../providers/pricing.js";
import { VerdictCache } from "../../routing/cache.js";
import { classifyTierWithModel, isClassifierEnabled } from "../../routing/classifier.js";
import { classifyQuery } from "../../routing/classify.js";
import type { ModelFilterRules } from "../../routing/filters.js";
import { filterModels, hasActiveFilters } from "../../routing/filters.js";
import { applyMomentum, currentTier, getTierHistory, recordTierDecision } from "../../routing/momentum.js";
import { detectTierOverride } from "../../routing/override.js";
import { decideTier } from "../../routing/policy.js";
import { scoreQuery } from "../../routing/scorer.js";
import { selectModel } from "../../routing/selector.js";
import type { CategoryPinMap } from "../../routing/specificity.js";
import { classifySpecificity, resolveCategoryPin } from "../../routing/specificity.js";
import { loadTierPools } from "../../routing/tier-assignment.js";
import { isTierAllowedFor, parseTierOverride, permittedTiersFor, TIER_OVERRIDE_HEADER, tierToCombinedScore } from "../../routing/tier-override.js";
import { classifyTier, QueryTier, scoreConfidence, tierMidpoint } from "../../routing/tiers.js";

const routeRouter = new OpenAPIHono<HonoEnv>();

const recordRoutingMetric = (
    c: { var: { telemetry: import("../../lib/otel/index.js").RequestTelemetry } },
    decision: { fromCache: boolean; modelId: string; pinned?: boolean; provider: string; tier: string },
): void => {
    c.var.telemetry.recordCounter(
        "gateway.routing_decisions_total",
        1,
        {
            from_cache: decision.fromCache,
            model: decision.modelId,
            pinned: decision.pinned ?? false,
            provider: decision.provider,
            tier: decision.tier,
        },
        "1",
    );
};

/** Extract text from the last user message for classification. */
const extractLastUserMessage = (messages: ModelMessage[]): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;

        if (message.role === "user") {
            if (typeof message.content === "string") return message.content;

            if (Array.isArray(message.content)) {
                return message.content
                    .filter((p): p is { text: string; type: "text" } => typeof p === "object" && p !== null && (p as { type: string }).type === "text")
                    .map((p) => p.text)
                    .join(" ");
            }
        }
    }

    return "";
};

/**
 * Rough size of the conversation so far, in tokens.
 *
 * Only the magnitude matters here — it feeds a threshold that decides whether
 * a downgrade is worth the prompt-cache rebuild it forces, and the answer does
 * not change between 180k and 200k. The 4-chars-per-token approximation is the
 * same one the scorer uses.
 */
const estimateContextTokens = (messages: ModelMessage[]): number => {
    let characters = 0;

    for (const message of messages) {
        if (typeof message.content === "string") {
            characters += message.content.length;
        } else if (Array.isArray(message.content)) {
            for (const part of message.content as { text?: string; type: string }[]) {
                if (part.type === "text" && part.text) {
                    characters += part.text.length;
                }
            }
        }
    }

    return characters / 4;
};

const requestSchema = z.object({
    /**
     * Optional user-pinned (provider, modelId) per specificity category. When
     * the active query classifies into a pinned category with ≥ 0.9 confidence
     * the gateway bypasses tier-based selection and uses the pin. Categories:
     * coding, web_browsing, data_analysis, image_generation, video_generation,
     * social_media, email_management, calendar_management, trading.
     */
    categoryPins: z.record(z.string(), z.object({ modelId: z.string(), provider: z.string() })).optional(),
    messages: z.array(z.record(z.string(), z.unknown())),

    /**
     * Model filter rules for geographic/compliance filtering.
     * When set, only models that pass all filter checks are eligible for routing.
     */
    modelFilterRules: z
        .object({
            allowedModels: z.array(z.string()).optional(),
            allowedProviders: z.array(z.string()).optional(),
            allowedRegions: z.array(z.string()).optional(),
            blockedModels: z.array(z.string()).optional(),
            blockedProviders: z.array(z.string()).optional(),
            blockedRegions: z.array(z.string()).optional(),
            denyDataCollection: z.boolean().optional(),
            requireZDR: z.boolean().optional(),
        })
        .optional(),
    preferredModel: z.string().optional(),
    preferredQuality: z.number().min(0).max(1).optional(),

    /**
     * Routing profile override. Bypasses the scoring engine and forces a tier:
     * - "fast": always simple tier (cheapest, lowest latency)
     * - "reasoning": always reasoning tier (most capable)
     * - "premium": forces complex or reasoning tier
     * - "balanced": default heuristic scoring (same as omitting)
     */
    routingProfile: z.enum(["fast", "balanced", "reasoning", "premium"]).optional(),
    threadId: z.string().optional(),
    toolSchemas: z.record(z.string(), z.unknown()).optional(),

    /**
     * Stable identifiers used to maintain session momentum (sticky-tier routing
     * within a thread). When both are present, the gateway biases routing
     * toward the dominant recent tier on borderline scores to reduce mid-
     * session model flapping. Omitting either disables momentum.
     */
    userId: z.string().optional(),
    userTier: z.string().default("free"),
});

routeRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/route",
        request: {
            body: {
                content: { "application/json": { schema: requestSchema } },
            },
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Routing decision",
            },
        },
        summary: "Smart model selection",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const messages = body.messages as ModelMessage[];
        const toolCount = body.toolSchemas ? Object.keys(body.toolSchemas).length : 0;
        const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((p: { type: string }) => p.type === "image" || p.type === "file"));
        const contextTokens = estimateContextTokens(messages);

        // Header-based tier override. Validated against the caller's userTier
        // so a free-plan request cannot self-promote to the reasoning tier.
        // The header takes precedence over body.routingProfile because callers
        // may want to A/B at the HTTP edge without re-deploying the JSON
        // contract.
        const tierOverrideHeader = c.req.header(TIER_OVERRIDE_HEADER);
        const tierOverrideResult = parseTierOverride(tierOverrideHeader, body.userTier);

        if (tierOverrideResult.error) {
            return c.json({ error: tierOverrideResult.error }, 403 as 200);
        }

        // Order matters below: filter rules are resolved before anything else
        // consults the catalogue, because "which tiers can this caller even
        // reach" is a function of the surviving candidates, and both the
        // category pin and the routing policy need that answer.
        const rules: ModelFilterRules | undefined = body.modelFilterRules as ModelFilterRules | undefined;
        let candidates = GATEWAY_MODELS;

        if (hasActiveFilters(rules)) {
            candidates = filterModels(GATEWAY_MODELS, rules);

            if (candidates.length === 0) {
                return c.json(
                    {
                        error: {
                            code: "MODEL_BLOCKED",
                            message: "No models available after applying filter rules. Check your region, model, and provider restrictions.",
                        },
                    },
                    403 as 200,
                );
            }
        }

        // Specificity classification — taxonomy of *what kind* of work the
        // query is about (coding/email/trading/...). Used for user-pinned
        // (provider, model) shortcuts that bypass tier-based routing when
        // confidence is high enough.
        const lastUserMessage = extractLastUserMessage(messages);
        const toolNames = body.toolSchemas ? Object.keys(body.toolSchemas) : [];
        const specificity = classifySpecificity(lastUserMessage, toolNames);
        const pin = resolveCategoryPin(specificity.category, specificity.confidence, body.categoryPins as CategoryPinMap | undefined);

        if (pin) {
            // A pin still has to survive the caller's own filter rules.
            const pinned = candidates.find((candidate) => candidate.modelId === pin.modelId && candidate.provider === pin.provider);

            if (pinned) {
                recordRoutingMetric(c, { fromCache: false, modelId: pinned.modelId, pinned: true, provider: pinned.provider, tier: "pinned" });

                return c.json(
                    {
                        classification: classifyQuery(lastUserMessage),
                        confidence: specificity.confidence,
                        estimatedCost: 0,
                        fromCache: false,
                        modelApiId: pinned.modelApiId,
                        modelId: pinned.modelId,
                        provider: pinned.provider,
                        routingReason: `Pinned for ${specificity.category}`,
                        specificity: { category: specificity.category, confidence: specificity.confidence, pinned: true },
                        tier: "pinned" as const,
                    },
                    200,
                );
            }
        }

        // Tier pools come from KV (refreshed by the recompute cron); the
        // loader derives them from `candidates` when no snapshot exists.
        const tierPools = await loadTierPools(c.env, candidates);

        // A tier is only a real option when the caller's plan permits it AND
        // at least one surviving candidate sits in its pool. Handing the
        // policy layer a tier that nothing can serve just defers the problem
        // to selector's arbitrary fallback.
        const availableTiers = permittedTiersFor(body.userTier).filter((tier) =>
            tierPools[tier].some((modelId) => candidates.some((candidate) => candidate.modelId === modelId)),
        );

        let score = scoreQuery({
            messages,
            preferredQuality: body.preferredQuality,
            // Our scorer counts tools rather than inspecting their schemas.
            toolCount: body.toolSchemas ? Object.keys(body.toolSchemas).length : undefined,
            userTier: body.userTier,
        });

        let momentum: ReturnType<typeof applyMomentum> | undefined;
        let policy: ReturnType<typeof decideTier> | undefined;
        let verdictSource: "heuristic" | "classifier" | "classifier-cache" | "caller-override" = "heuristic";
        let verdictConfidence: number | undefined;
        let classifierMs: number | undefined;

        // Caller-level overrides — the `x-gateway-tier` header and the
        // `routingProfile` field — are authoritative. They are set by the
        // integration rather than inferred from the turn, so they skip the
        // policy layer entirely; there is nothing to second-guess.
        if (tierOverrideResult.tier) {
            score = { ...score, combined: tierToCombinedScore(tierOverrideResult.tier) };
            verdictSource = "caller-override";
        } else {
            switch (body.routingProfile) {
                case "fast": {
                    score = { ...score, combined: tierMidpoint(QueryTier.Simple) };
                    verdictSource = "caller-override";

                    break;
                }
                case "premium": {
                    score = { ...score, combined: tierMidpoint(QueryTier.Complex) };
                    verdictSource = "caller-override";

                    break;
                }
                case "reasoning": {
                    score = { ...score, combined: tierMidpoint(QueryTier.Reasoning) };
                    verdictSource = "caller-override";

                    break;
                }
                default: {
                    const history = body.userId && body.threadId ? await getTierHistory(c.env.PRICING_KV, body.userId, body.threadId) : [];

                    // Momentum resolves near-boundary flapping on the heuristic score.
                    // It only shifts a score already sitting within a hair of the
                    // dominant tier's band, so it cannot mask a genuine change of
                    // intent — and the policy layer below provides the stronger
                    // anti-flap guarantee regardless of which verdict wins.
                    if (history.length > 0) {
                        momentum = applyMomentum(score, history);

                        if (momentum.biased) {
                            score = { ...score, combined: momentum.combined };
                        }
                    }

                    let target = classifyTier(score.combined);

                    // The heuristic scorer publishes no confidence of its own, so it
                    // is derived from where the score falls inside its band.
                    verdictConfidence = scoreConfidence(score.combined);

                    if (isClassifierEnabled(c.env) && availableTiers.length > 0) {
                        const verdictCache = new VerdictCache(c.env.PRICING_KV);
                        const cacheKey = { availableTiers, hasImages, lastUserMessage, toolCount };
                        const cached = await verdictCache.get(cacheKey);

                        if (cached) {
                            target = cached.tier;
                            verdictConfidence = cached.confidence;
                            verdictSource = "classifier-cache";
                        } else {
                            const verdict = await classifyTierWithModel(c.env, { availableTiers, contextTokens, lastUserMessage });

                            if (verdict) {
                                target = verdict.tier;
                                verdictConfidence = verdict.confidence;
                                classifierMs = verdict.ms;
                                verdictSource = "classifier";
                                c.executionCtx.waitUntil(verdictCache.put(cacheKey, { confidence: verdict.confidence, tier: verdict.tier }));
                            }
                        }
                    }

                    // A tier the user named in their own words outranks the verdict —
                    // but not their plan, so it is dropped when unaffordable rather
                    // than promoting the caller.
                    const namedTier = detectTierOverride(lastUserMessage);
                    const honouredOverride = namedTier && isTierAllowedFor(namedTier, body.userTier) ? namedTier : null;

                    policy = decideTier({
                        available: availableTiers,
                        confidence: verdictConfidence,
                        contextTokens,
                        current: currentTier(history),
                        override: honouredOverride,
                        target,
                    });

                    score = { ...score, combined: tierMidpoint(policy.tier) };
                }
            }
        }

        // If the preferred model is blocked by filters, clear it for auto-routing
        let effectivePreferredModel = body.preferredModel;

        if (effectivePreferredModel && hasActiveFilters(rules) && candidates.every((candidate) => candidate.modelId !== effectivePreferredModel)) {
            effectivePreferredModel = undefined;
        }

        const healthService = new ProviderHealthService(c.env);
        const pricingService = new PricingService(c.env);
        const result = await selectModel(score, candidates, healthService, effectivePreferredModel, pricingService, tierPools);

        const classification = classifyQuery(lastUserMessage);

        // Record the chosen tier for the next turn's momentum and policy. This
        // is unconditional: skipping it on some paths leaves holes in the
        // history exactly where the thread is most active, which is when
        // stickiness matters most.
        if (body.userId && body.threadId) {
            c.executionCtx.waitUntil(recordTierDecision(c.env.PRICING_KV, body.userId, body.threadId, result.tier));
        }

        recordRoutingMetric(c, { fromCache: verdictSource === "classifier-cache", modelId: result.modelId, provider: result.provider, tier: result.tier });

        c.var.telemetry.recordHistogram("gateway.route_score_combined", score.combined, { tier: result.tier }, "1");

        if (classifierMs !== undefined) {
            c.var.telemetry.recordHistogram("gateway.route_classifier_ms", classifierMs, { tier: result.tier }, "ms");
        }

        return c.json(
            {
                ...result,
                classification,
                // Why this tier, in a form a human reading a log can act on.
                decision: {
                    source: verdictSource,
                    ...(verdictConfidence !== undefined && { confidence: verdictConfidence }),
                    ...(classifierMs !== undefined && { classifierMs }),
                    ...(policy && { changed: policy.changed, reason: policy.reason, tier: policy.tier }),
                    availableTiers,
                    contextTokens,
                },
                fromCache: false,
                score: {
                    codeGeneration: score.codeGeneration,
                    combined: score.combined,
                    complexity: score.complexity,
                    contextLength: score.contextLength,
                    reasoning: score.reasoning,
                    toolUse: score.toolUse,
                },
                specificity: { category: specificity.category, confidence: specificity.confidence, pinned: false },
                ...(momentum?.biased && { momentum: { biased: true, biasedTo: momentum.biasedTo, rawTier: momentum.rawTier } }),
            },
            200,
        );
    },
);

export { routeRouter };
