/**
 * 4-tier query classification with configurable boundaries.
 *
 * Each tier maps to a pool of candidate models, ranked by cost-effectiveness.
 */

export enum QueryTier {
    Complex = "complex",
    Reasoning = "reasoning",
    Simple = "simple",
    Standard = "standard",
}

/** Configurable boundaries (tuned over time based on usage data) */
export const TIER_BOUNDARIES = {
    complex: { maxScore: 0.8 },
    reasoning: { maxScore: 1 },
    simple: { maxScore: 0.25 },
    standard: { maxScore: 0.55 },
};

/** Ranked candidate models per tier. First = preferred (cheapest adequate model). */
export const TIER_MODEL_POOLS: Record<QueryTier, string[]> = {
    [QueryTier.Complex]: ["claude-sonnet-4", "gpt-4.1", "gemini-2.5-pro"],
    [QueryTier.Reasoning]: ["claude-opus-4", "o3", "gemini-2.5-pro"],
    [QueryTier.Simple]: ["gemini-2.5-flash", "gpt-4o-mini", "llama-4-scout"],
    [QueryTier.Standard]: ["gpt-4o", "gemini-2.5-pro", "claude-sonnet-4"],
};

/**
 * Classify a combined score into a query tier.
 */
export const classifyTier = (combinedScore: number): QueryTier => {
    if (combinedScore <= TIER_BOUNDARIES.simple.maxScore) return QueryTier.Simple;

    if (combinedScore <= TIER_BOUNDARIES.standard.maxScore) return QueryTier.Standard;

    if (combinedScore <= TIER_BOUNDARIES.complex.maxScore) return QueryTier.Complex;

    return QueryTier.Reasoning;
};

/** Tiers weakest-first. Index = rank, so `TIER_ORDER[rankOf(t)] === t`. */
export const TIER_ORDER: ReadonlyArray<QueryTier> = [QueryTier.Simple, QueryTier.Standard, QueryTier.Complex, QueryTier.Reasoning];

/** Position of a tier in {@link TIER_ORDER}. Higher = more capable and more expensive. */
export const rankOf = (tier: QueryTier): number => TIER_ORDER.indexOf(tier);

/** Score band each tier occupies, as [lower, upper]. */
const TIER_BANDS: Record<QueryTier, readonly [number, number]> = {
    [QueryTier.Complex]: [TIER_BOUNDARIES.standard.maxScore, TIER_BOUNDARIES.complex.maxScore],
    [QueryTier.Reasoning]: [TIER_BOUNDARIES.complex.maxScore, 1],
    [QueryTier.Simple]: [0, TIER_BOUNDARIES.simple.maxScore],
    [QueryTier.Standard]: [TIER_BOUNDARIES.simple.maxScore, TIER_BOUNDARIES.standard.maxScore],
};

/**
 * Midpoint of a tier's score band — used to express "land in this tier" as the
 * synthetic `score.combined` the selection pipeline consumes.
 */
export const tierMidpoint = (tier: QueryTier): number => {
    const [lower, upper] = TIER_BANDS[tier];

    return (lower + upper) / 2;
};

/**
 * Confidence floor/ceiling for a heuristic tier call. A score exactly on a
 * boundary earns the floor; one dead-centre in its band earns the ceiling.
 * The floor sits below the routing policy's `minConfidence` on purpose, so a
 * genuinely borderline score is treated as uncertain.
 */
const MIN_SCORE_CONFIDENCE = 0.45;
const MAX_SCORE_CONFIDENCE = 0.95;

/**
 * How much to trust `classifyTier(combined)` for a given score.
 *
 * The heuristic scorer reports no confidence of its own, but the geometry of
 * the bands supplies one: a score sitting on a tier boundary is a coin-flip
 * between two tiers, while one in the middle of a band is a clear call. That
 * distinction is what lets a borderline turn be treated as uncertain — and
 * uncertainty is handled asymmetrically by the routing policy, so it has to
 * be expressed rather than assumed away.
 *
 * Returned on the same 0–1 scale as the model classifier's confidence, floored
 * well above zero: a boundary score is ambiguous, not uninformative.
 */
export const scoreConfidence = (combined: number): number => {
    const [lower, upper] = TIER_BANDS[classifyTier(combined)];
    const halfWidth = (upper - lower) / 2;

    if (halfWidth <= 0) {
        return MIN_SCORE_CONFIDENCE;
    }

    const distanceToEdge = Math.min(combined - lower, upper - combined);
    const centrality = Math.max(0, Math.min(1, distanceToEdge / halfWidth));

    return MIN_SCORE_CONFIDENCE + centrality * (MAX_SCORE_CONFIDENCE - MIN_SCORE_CONFIDENCE);
};

/**
 * Named routing profiles exposed on the public classification API.
 *
 * `auto` defers to the scored tier; every other value is an explicit
 * instruction that overrides scoring. Kept as a superset of the profile
 * vocabulary on `/internal/route` so the two surfaces can converge.
 */
export type RoutingProfile = "auto" | "eco" | "fast" | "free" | "premium" | "reasoning";

/**
 * Resolve the tier a profile asks for.
 *
 * `premium` raises to at least Complex but leaves an already-Reasoning scored
 * tier alone — it is a floor, not a pin, so a genuinely hard query is not
 * demoted by asking for premium.
 */
export const applyRoutingProfile = (scoredTier: QueryTier, profile: RoutingProfile): QueryTier => {
    switch (profile) {
        case "auto": {
            return scoredTier;
        }
        // `eco`, `free` and `fast` all mean "cheapest pool"; they differ in
        // intent (cost, plan, latency) but land on the same tier today.
        case "eco":
        case "fast":
        case "free": {
            return QueryTier.Simple;
        }
        case "premium": {
            return rankOf(scoredTier) > rankOf(QueryTier.Complex) ? scoredTier : QueryTier.Complex;
        }
        case "reasoning": {
            return QueryTier.Reasoning;
        }
        // Unreachable while RoutingProfile stays a closed union, but a profile
        // added without a case here must not silently fall through to
        // `undefined` — deferring to the scored tier is the safe default.
        default: {
            return scoredTier;
        }
    }
};
