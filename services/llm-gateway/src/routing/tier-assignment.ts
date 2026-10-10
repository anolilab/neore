/**
 * Automatic tier-pool assignment.
 *
 * Walks the gateway's full candidate catalogue, scores each model against
 * tier-specific criteria (cost, capability, context window, freshness), and
 * persists the resulting `Record&lt;QueryTier, string[]>` to KV.
 *
 * The static `TIER_MODEL_POOLS` in `tiers.ts` remains the cold-start fallback;
 * the cron-driven recomputation lets the gateway track new/retired models and
 * pricing changes without a code deploy.
 */
import type { AppEnv } from "../env.js";
import type { ModelPricing } from "../providers/pricing.js";
import { PricingService } from "../providers/pricing.js";
import type { ModelCandidate } from "./selector.js";
import { QueryTier, TIER_MODEL_POOLS } from "./tiers.js";

/**
 * KV key for the persisted pool override. Versioned so a future schema change
 * (e.g. richer per-tier metadata) can be rolled out without colliding with
 * stale entries.
 */
const TIER_POOLS_KV_KEY = "tier_pools:v1";

/**
 * 14-day TTL — long enough that one or two missed weekly crons still leave
 * a recent snapshot in place, short enough that a fully decommissioned
 * gateway eventually falls back to the static defaults.
 */
const TIER_POOLS_TTL_SECONDS = 60 * 60 * 24 * 14;

/** Maximum entries kept per tier — keeps fallback chains short and predictable. */
const MAX_MODELS_PER_TIER = 5;

/**
 * Per-tier scoring criteria. The numbers below describe the *target* model
 * for that tier. Candidates are scored by how well they match — not pass/fail.
 *
 * - `maxAvgCostPerMillion` — hard cap on `(input + output) / 2` USD price.
 *   Anything above is disqualified for the tier (prevents Opus from showing
 *   up in Simple, etc.).
 * - `idealAvgCostPerMillion` — score peaks here; cheaper is fine, more
 *   expensive linearly degrades up to the hard cap.
 * - `minContextWindow` — hard floor on context size.
 * - `requireMultimodal` / `requireTools` — hard requirements.
 * - `reasoningBoost` — additive bonus for reasoning-flagged models (currently
 *   detected by modelApiId prefix, see `isReasoningModel`).
 */
interface TierCriteria {
    /** Disqualify if reasoning model is selected for non-reasoning tier */
    excludeReasoning: boolean;
    idealAvgCostPerMillion: number;
    maxAvgCostPerMillion: number;
    minContextWindow: number;
    reasoningBoost: number;
    requireMultimodal: boolean;
    requireTools: boolean;
}

const TIER_CRITERIA: Record<QueryTier, TierCriteria> = {
    [QueryTier.Complex]: {
        // Cheap reasoning models exist now, and the cost cap is the guard that
        // actually matters; excluding by capability confined whole families to
        // the most expensive pool.
        excludeReasoning: false,
        idealAvgCostPerMillion: 9,
        maxAvgCostPerMillion: 30,
        minContextWindow: 128_000,
        reasoningBoost: 0,
        requireMultimodal: false,
        requireTools: true,
    },
    [QueryTier.Reasoning]: {
        excludeReasoning: false,
        idealAvgCostPerMillion: 30,
        maxAvgCostPerMillion: 100,
        minContextWindow: 128_000,
        reasoningBoost: 0.25,
        requireMultimodal: false,
        requireTools: true,
    },
    [QueryTier.Simple]: {
        excludeReasoning: true,
        idealAvgCostPerMillion: 0.3,
        maxAvgCostPerMillion: 1.5,
        minContextWindow: 32_000,
        reasoningBoost: 0,
        requireMultimodal: false,
        requireTools: true,
    },
    [QueryTier.Standard]: {
        // Cheap reasoning models exist now, and the cost cap above is the
        // guard that actually matters. Excluding them by capability instead
        // confined whole model families to the most expensive pool.
        excludeReasoning: false,
        idealAvgCostPerMillion: 3,
        maxAvgCostPerMillion: 8,
        minContextWindow: 64_000,
        reasoningBoost: 0,
        requireMultimodal: false,
        requireTools: true,
    },
};

/**
 * Name-shaped fallback for "this model runs a reasoning pass", used only when
 * the candidate carries no explicit capability flag.
 *
 * Matching on the family name alone is too coarse to be the primary signal:
 * a pattern like `gpt-5` matches every member of a family, including the cheap
 * variants that belong in the everyday tiers, which quietly confines the whole
 * family to the most expensive pool. The generated catalogue publishes a
 * per-model capability list, so that is consulted first and this only covers
 * the hand-maintained routing candidates.
 */
const REASONING_PATTERNS: RegExp[] = [/(?:^|\/)o[1-9](?:-|$)/i, /claude-opus/i, /claude-3-7-sonnet.*thinking/i, /deepseek-r1/i, /grok-4/i, /gemini-2\.5-pro/i];

export const isReasoningModel = (candidate: ModelCandidate): boolean => {
    if (candidate.supportsReasoning !== undefined) {
        return candidate.supportsReasoning;
    }

    const haystack = `${candidate.modelId} ${candidate.modelApiId}`;

    return REASONING_PATTERNS.some((pattern) => pattern.test(haystack));
};

/**
 * Resolve a candidate's effective average cost — prefer live pricing from KV
 * (models.dev refreshed daily) and fall back to the static cost on the
 * candidate definition when models.dev has no entry.
 */
const resolveAvgCost = (candidate: ModelCandidate, pricing: ModelPricing | null): number => {
    if (pricing) {
        return (pricing.inputPerMillion + pricing.outputPerMillion) / 2;
    }

    return (candidate.costPerMillionInput + candidate.costPerMillionOutput) / 2;
};

/**
 * Score a single candidate for a given tier. Returns null if the candidate
 * fails a hard requirement, otherwise a score in [0, 1].
 */
export const scoreCandidateForTier = (candidate: ModelCandidate, pricing: ModelPricing | null, tier: QueryTier): number | null => {
    const criteria = TIER_CRITERIA[tier];

    // Hard requirements
    if (criteria.requireMultimodal && !candidate.supportsMultimodal) return null;

    if (criteria.requireTools && !candidate.supportsTools) return null;

    const contextWindow = pricing?.contextWindow ?? candidate.contextWindow ?? 0;

    if (contextWindow < criteria.minContextWindow) return null;

    const isReasoning = isReasoningModel(candidate);

    if (isReasoning && criteria.excludeReasoning) return null;

    const avgCost = resolveAvgCost(candidate, pricing);

    if (avgCost > criteria.maxAvgCostPerMillion) return null;

    // Cost score: 1.0 at ideal, linearly degrading toward the hard cap.
    // Models cheaper than ideal still get 1.0 (no bonus) so a near-zero
    // model doesn't beat a slightly-pricier-but-clearly-better one in the
    // Standard/Complex tiers.
    const costScore =
        avgCost <= criteria.idealAvgCostPerMillion
            ? 1
            : Math.max(0, 1 - (avgCost - criteria.idealAvgCostPerMillion) / (criteria.maxAvgCostPerMillion - criteria.idealAvgCostPerMillion));

    // Context score: capped at 2x minContextWindow so a 1M-context model
    // doesn't dominate every tier purely on size.
    const contextScore = Math.min(1, contextWindow / (criteria.minContextWindow * 2));

    // Capability bonus: multimodal models score slightly higher in tiers
    // where multimodal isn't required, since real traffic increasingly
    // includes images.
    const multimodalBonus = candidate.supportsMultimodal ? 0.05 : 0;

    // Reasoning bonus only applies to the Reasoning tier (other tiers exclude
    // reasoning models entirely).
    const reasoningBonus = isReasoning && tier === QueryTier.Reasoning ? criteria.reasoningBoost : 0;

    // Weighted sum, normalised so the maximum is ~1.0 with bonuses.
    const score = costScore * 0.55 + contextScore * 0.25 + multimodalBonus + reasoningBonus + 0.15;

    return Math.min(1, score);
};

export interface TierAssignment {
    avgCostPerMillion: number;
    contextWindow: number;
    modelId: string;
    score: number;
    tier: QueryTier;
}

/**
 * Compute the tier-pool mapping by scoring every candidate against every
 * tier and keeping the top `MAX_MODELS_PER_TIER` per tier. Each tier's
 * pool is sorted score-descending; downstream selection (selector.ts)
 * already preferses lower indices.
 */
export const computeTierPools = async (
    candidates: ModelCandidate[],
    pricingService: PricingService,
): Promise<{ assignments: TierAssignment[]; pools: Record<QueryTier, string[]> }> => {
    // Pre-fetch pricing for every candidate (fan-out is cheap because pricing
    // service is KV-cached).
    const pricingByCandidate = new Map<string, ModelPricing | null>();

    await Promise.all(
        candidates.map(async (c) => {
            try {
                const p = await pricingService.getPricing(c.modelApiId);

                pricingByCandidate.set(c.modelId, p);
            } catch {
                pricingByCandidate.set(c.modelId, null);
            }
        }),
    );

    const pools: Record<QueryTier, string[]> = {
        [QueryTier.Complex]: [],
        [QueryTier.Reasoning]: [],
        [QueryTier.Simple]: [],
        [QueryTier.Standard]: [],
    };
    const assignments: TierAssignment[] = [];

    for (const tier of Object.values(QueryTier)) {
        const tierKey = tier as QueryTier;
        const scored: { candidate: ModelCandidate; pricing: ModelPricing | null; score: number }[] = [];

        for (const candidate of candidates) {
            const pricing = pricingByCandidate.get(candidate.modelId) ?? null;
            const score = scoreCandidateForTier(candidate, pricing, tierKey);

            if (score !== null) {
                scored.push({ candidate, pricing, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);

        const top = scored.slice(0, MAX_MODELS_PER_TIER);

        pools[tierKey] = top.map((s) => s.candidate.modelId);

        for (const entry of top) {
            assignments.push({
                avgCostPerMillion: resolveAvgCost(entry.candidate, entry.pricing),
                contextWindow: entry.pricing?.contextWindow ?? entry.candidate.contextWindow ?? 0,
                modelId: entry.candidate.modelId,
                score: entry.score,
                tier: tierKey,
            });
        }
    }

    return { assignments, pools };
};

export type PersistedPools = {
    /** Diagnostic — top picks per tier with score/cost/context. */
    assignments?: TierAssignment[];
    /** ISO-8601 timestamp of the cron run that wrote this snapshot. */
    computedAt: string;
    pools: Record<QueryTier, string[]>;
};

/**
 * Derive tier pools from the candidate catalogue using only the static cost
 * and capability data already on each candidate — no KV, no pricing service,
 * no `await`.
 *
 * This is the cold-start path. The alternative, a hardcoded list of model
 * names, goes stale the moment a model is renamed or retired and then quietly
 * routes to IDs that no longer resolve; deriving the pools from the catalogue
 * keeps cold start consistent with whatever the gateway actually ships.
 */
export const computeStaticTierPools = (candidates: ModelCandidate[]): Record<QueryTier, string[]> => {
    const pools: Record<QueryTier, string[]> = {
        [QueryTier.Complex]: [],
        [QueryTier.Reasoning]: [],
        [QueryTier.Simple]: [],
        [QueryTier.Standard]: [],
    };

    for (const tier of Object.values(QueryTier)) {
        const scored: { modelId: string; score: number }[] = [];

        for (const candidate of candidates) {
            const score = scoreCandidateForTier(candidate, null, tier);

            if (score !== null) {
                scored.push({ modelId: candidate.modelId, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        pools[tier] = scored.slice(0, MAX_MODELS_PER_TIER).map((entry) => entry.modelId);
    }

    return pools;
};

/**
 * Read tier pools from KV. Falls back to pools derived from `candidates`
 * (cold start or KV unreachable), and only then to the static
 * `TIER_MODEL_POOLS` map if the catalogue yields nothing usable.
 */
export const loadTierPools = async (env: AppEnv, candidates?: ModelCandidate[]): Promise<Record<QueryTier, string[]>> => {
    try {
        const stored = await env.PRICING_KV.get(TIER_POOLS_KV_KEY, "json");

        if (stored && typeof stored === "object" && "pools" in stored) {
            const persisted = stored as PersistedPools;
            // Defence-in-depth: ensure every tier still has at least one model
            // before honouring the snapshot. A pool with all empty arrays would
            // route every request into the fallback path.
            const allTiersPopulated = Object.values(QueryTier).every((t) => {
                const list = persisted.pools[t as QueryTier];

                return Array.isArray(list) && list.length > 0;
            });

            if (allTiersPopulated) {
                return persisted.pools;
            }
        }
    } catch {
        // KV read failure → fall back to the catalogue-derived pools.
    }

    if (candidates && candidates.length > 0) {
        const derived = computeStaticTierPools(candidates);

        if (Object.values(QueryTier).every((tier) => derived[tier].length > 0)) {
            return derived;
        }
    }

    return TIER_MODEL_POOLS;
};

/**
 * Persist the recomputed pools to KV. Failure is non-fatal — the gateway
 * keeps serving from the previous snapshot (or the static defaults).
 */
export const saveTierPools = async (env: AppEnv, pools: Record<QueryTier, string[]>, assignments?: TierAssignment[]): Promise<void> => {
    const payload: PersistedPools = {
        assignments,
        computedAt: new Date().toISOString(),
        pools,
    };

    await env.PRICING_KV.put(TIER_POOLS_KV_KEY, JSON.stringify(payload), {
        expirationTtl: TIER_POOLS_TTL_SECONDS,
    });
};

/**
 * Cron entry-point — recompute and persist pools. Returns the snapshot for
 * logging.
 */
export const recomputeTierPools = async (env: AppEnv, candidates: ModelCandidate[]): Promise<PersistedPools> => {
    const pricingService = new PricingService(env);
    const { assignments, pools } = await computeTierPools(candidates, pricingService);

    await saveTierPools(env, pools, assignments);

    return { assignments, computedAt: new Date().toISOString(), pools };
};

export { TIER_POOLS_KV_KEY };
