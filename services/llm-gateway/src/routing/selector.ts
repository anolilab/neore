/**
 * Model selection from scored candidates.
 *
 * Given a query score and tier, selects the most cost-effective model
 * that meets quality requirements, respecting provider health and user preferences.
 */
import type { ProviderHealthService } from "../providers/health.js";
import type { ModelPricing, PricingService } from "../providers/pricing.js";
import { calculateCost } from "../providers/pricing.js";
import type { QueryScore } from "./dimensions.js";
import type { QueryTier } from "./tiers.js";
import { classifyTier, TIER_MODEL_POOLS } from "./tiers.js";

export interface ModelCandidate {
    /** Maximum context window in tokens. Used for pre-flight overflow checks. */
    contextWindow?: number;
    costPerMillionInput: number;
    costPerMillionOutput: number;
    modelApiId: string;
    modelId: string;
    provider: string;

    /**
     * Data-processing regions where this model is hosted.
     * Used for geographic/compliance filtering.
     * Empty array or undefined = unknown/global.
     */
    regions?: string[];
    supportsMultimodal: boolean;

    /**
     * Whether the model runs an internal reasoning/thinking pass. Sourced from
     * the generated catalogue's capability list; used both to shape tier pools
     * and to decide whether reasoning-related provider options are meaningful
     * for this model.
     */
    supportsReasoning?: boolean;
    supportsTools: boolean;
}

export interface RouteResult {
    alternativeModelId?: string;
    confidence: number;
    estimatedCost: number;
    modelApiId: string;
    modelId: string;
    provider: string;
    routingReason: string;
    tier: QueryTier;
}

/**
 * Estimate cost in microdollars from query dimensions and model pricing.
 * Uses contextLength (normalized 0-1) to approximate input tokens,
 * and assumes output is ~30% of input for typical queries.
 */
const estimateCostForCandidate = (candidate: ModelCandidate, score: QueryScore, pricing: ModelPricing | null): number => {
    // contextLength is normalized against ~32k tokens (see scorer.ts)
    const estimatedInputTokens = Math.max(score.contextLength * 32_000, 100);
    const estimatedOutputTokens = estimatedInputTokens * 0.3;

    if (pricing) {
        return calculateCost(pricing, {
            completionTokens: estimatedOutputTokens,
            promptTokens: estimatedInputTokens,
        });
    }

    // Fallback: use static cost from candidate definition
    const inputCost = (estimatedInputTokens * candidate.costPerMillionInput) / 1_000_000;
    const outputCost = (estimatedOutputTokens * candidate.costPerMillionOutput) / 1_000_000;

    return Math.round((inputCost + outputCost) * 1_000_000);
};

/**
 * Select the best model for a given query.
 *
 * `tierPools` overrides the static `TIER_MODEL_POOLS` map — pass the result
 * of `loadTierPools(env)` when the caller has access to KV (so cron-driven
 * pool updates take effect). When omitted, the static defaults are used.
 */
export const selectModel = async (
    score: QueryScore,
    candidates: ModelCandidate[],
    healthService: ProviderHealthService,
    preferredModel?: string,
    pricingService?: PricingService,
    tierPools?: Record<QueryTier, string[]>,
): Promise<RouteResult> => {
    const tier = classifyTier(score.combined);
    const pools = tierPools ?? TIER_MODEL_POOLS;
    const modelPool = pools[tier];

    // If user has an explicit preference and it's healthy, respect it
    if (preferredModel) {
        const preferred = candidates.find((c) => c.modelId === preferredModel);

        if (preferred) {
            const healthy = await healthService.isHealthy(preferred.provider, preferred.modelApiId);

            if (healthy) {
                const pricing = pricingService ? await pricingService.getPricing(preferred.modelApiId) : null;

                return {
                    confidence: 0.95,
                    estimatedCost: estimateCostForCandidate(preferred, score, pricing),
                    modelApiId: preferred.modelApiId,
                    modelId: preferred.modelId,
                    provider: preferred.provider,
                    routingReason: `User selected ${preferred.modelId}`,
                    tier,
                };
            }

            // Preferred model is down — fall through to auto-selection
        }
    }

    // Filter candidates by tier pool and hard requirements
    const eligible = candidates.filter((c) => {
        // Must be in the tier's model pool
        if (!modelPool.includes(c.modelId)) return false;

        // Hard requirement: multimodal support if query has images
        if (score.multimodal > 0 && !c.supportsMultimodal) return false;

        // Hard requirement: tool support if tools are present
        if (score.toolUse > 0 && !c.supportsTools) return false;

        return true;
    });

    // Score each eligible candidate
    const scored = await Promise.all(
        eligible.map(async (c) => {
            const healthy = await healthService.isHealthy(c.provider, c.modelApiId);
            const healthFactor = healthy ? 1 : 0;

            // Cost-effectiveness: prefer cheaper models (inverted cost)
            const avgCost = (c.costPerMillionInput + c.costPerMillionOutput) / 2;
            const costFactor = avgCost > 0 ? 1 / (1 + avgCost / 10) : 0.5;

            // Quality fit: models earlier in pool list are preferred
            const poolIndex = modelPool.indexOf(c.modelId);
            const qualityFactor = poolIndex === -1 ? 0.5 : 1 - poolIndex * 0.15;

            const totalScore = qualityFactor * 0.4 + costFactor * 0.3 + healthFactor * 0.3;

            return { candidate: c, totalScore };
        }),
    );

    // Sort by score descending
    scored.sort((a, b) => b.totalScore - a.totalScore);

    const best = scored[0];

    if (!best) {
        // No eligible candidates — fall back to first in tier pool
        const fallbackId = modelPool[0] ?? "gpt-4o";
        const fallbackCandidate = candidates.find((c) => c.modelId === fallbackId);

        return {
            confidence: 0.3,
            estimatedCost: 0,
            modelApiId: fallbackCandidate?.modelApiId ?? fallbackId,
            modelId: fallbackId,
            provider: fallbackCandidate?.provider ?? "openrouter",
            routingReason: `No eligible candidates for tier ${tier}; falling back to ${fallbackId}`,
            tier,
        };
    }

    const alternative = scored[1];
    const pricing = pricingService ? await pricingService.getPricing(best.candidate.modelApiId) : null;

    return {
        alternativeModelId: alternative?.candidate.modelId,
        confidence: Math.min(best.totalScore + 0.2, 1),
        estimatedCost: estimateCostForCandidate(best.candidate, score, pricing),
        modelApiId: best.candidate.modelApiId,
        modelId: best.candidate.modelId,
        provider: best.candidate.provider,
        routingReason: `Tier ${tier}: selected ${best.candidate.modelId} (score: ${best.totalScore.toFixed(2)})`,
        tier,
    };
};
