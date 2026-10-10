/**
 * Session momentum — sticky-tier routing for chat threads.
 *
 * Long threads tend to stay in the same complexity band: a coding session
 * stays "complex" turn-after-turn, a casual chat stays "simple". The 23-dim
 * scorer is stateless and re-decides every turn — when a single message
 * lands near a tier boundary the routed model can flap between e.g.
 * `gpt-4o-mini` and `gpt-4o`, costing latency, prompt-cache hits, and
 * occasionally noticeable quality changes mid-session.
 *
 * Momentum reads the recent tier history for {userId,threadId} and biases
 * the current score toward the dominant recent tier when:
 *   - 3+ recent decisions are the same tier, AND
 *   - the current combined score is within ±0.08 of the dominant tier's
 *     range (i.e. on the fence).
 *
 * Storage: KV per-thread deque, 5 deep, 30min sliding TTL. Read+write are
 * best-effort — if KV is unavailable the scorer falls back to the raw score.
 */
import type { QueryScore } from "./dimensions.js";
import { classifyTier, QueryTier, TIER_BOUNDARIES, tierMidpoint } from "./tiers.js";

// QueryTier imported as a VALUE, not `import type`: TIER_VALUES enumerates it
// at runtime. `tierMidpoint` now lives in tiers.ts — the local copy this file
// used to carry is gone, so the two cannot drift apart.
const TIER_VALUES = new Set<string>(Object.values(QueryTier));

const HISTORY_DEPTH = 5;
const HISTORY_TTL_SECONDS = 30 * 60;
const MIN_CONFIRMATIONS = 3;
const BOUNDARY_BAND = 0.08;

const tierRange = (tier: QueryTier): { max: number; min: number } => {
    if (tier === "simple") return { max: TIER_BOUNDARIES.simple.maxScore, min: 0 };

    if (tier === "standard") return { max: TIER_BOUNDARIES.standard.maxScore, min: TIER_BOUNDARIES.simple.maxScore };

    if (tier === "complex") return { max: TIER_BOUNDARIES.complex.maxScore, min: TIER_BOUNDARIES.standard.maxScore };

    return { max: 1, min: TIER_BOUNDARIES.complex.maxScore };
};

/** Composite KV key. Includes userId so a shared device can't poison another user's history. */
const historyKey = (userId: string, threadId: string): string => `mtm:${userId}:${threadId}`;

/** Read the recent tier history. Returns oldest-first. */
export const getTierHistory = async (kv: KVNamespace | undefined, userId: string, threadId: string): Promise<QueryTier[]> => {
    if (!kv) return [];

    try {
        const raw = await kv.get(historyKey(userId, threadId));

        if (!raw) return [];

        const parsed = JSON.parse(raw) as unknown;

        if (!Array.isArray(parsed)) return [];

        return parsed.filter((x): x is QueryTier => typeof x === "string" && TIER_VALUES.has(x));
    } catch {
        return [];
    }
};

/** Append a tier decision. Bounded at HISTORY_DEPTH; resets the 30-min TTL. */
export const recordTierDecision = async (kv: KVNamespace | undefined, userId: string, threadId: string, tier: QueryTier): Promise<void> => {
    if (!kv) return;

    try {
        const history = await getTierHistory(kv, userId, threadId);

        history.push(tier);

        const trimmed = history.slice(-HISTORY_DEPTH);

        await kv.put(historyKey(userId, threadId), JSON.stringify(trimmed), { expirationTtl: HISTORY_TTL_SECONDS });
    } catch {
        // Best-effort — never block routing on KV failures.
    }
};

/**
 * Tier this thread ran on last turn, or `null` when it has no history. This is
 * the "current" model the routing policy protects against needless switching.
 */
export const currentTier = (history: ReadonlyArray<QueryTier>): QueryTier | null => history[history.length - 1] ?? null;

/** Most-frequent tier in the recent history, with the count. Returns null if history is empty. */
const dominantTier = (history: QueryTier[]): { count: number; tier: QueryTier } | null => {
    if (history.length === 0) return null;

    const counts = new Map<QueryTier, number>();

    for (const t of history) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
    }

    let best: { count: number; tier: QueryTier } | null = null;

    for (const [tier, count] of counts) {
        if (!best || count > best.count) {
            best = { count, tier };
        }
    }

    return best;
};

export interface MomentumDecision {
    /** Whether momentum altered the score. */
    biased: boolean;
    /** Tier momentum biased toward (only set when `biased=true`). */
    biasedTo?: QueryTier;
    /** Combined score after momentum bias. May equal `score.combined` when no bias applied. */
    combined: number;
    /** Tier the raw score would have produced. */
    rawTier: QueryTier;
}

/**
 * Apply session momentum to a query score.
 *
 * Returns the (possibly biased) combined score plus diagnostic fields. The
 * scorer's other dimensions are NOT modified — only the combined score that
 * drives tier classification.
 */
export const applyMomentum = (score: QueryScore, history: QueryTier[]): MomentumDecision => {
    const rawTier = classifyTier(score.combined);
    const dominant = dominantTier(history);

    if (!dominant || dominant.count < MIN_CONFIRMATIONS) {
        return { biased: false, combined: score.combined, rawTier };
    }

    if (dominant.tier === rawTier) {
        return { biased: false, combined: score.combined, rawTier };
    }

    const dominantRange = tierRange(dominant.tier);
    const distance = Math.min(Math.abs(score.combined - dominantRange.min), Math.abs(score.combined - dominantRange.max));

    if (distance > BOUNDARY_BAND) {
        // Current score is far from the dominant tier — momentum should not
        // override a clearly-different intent (e.g., user pivots from
        // "what's the weather" to "implement a B-tree").
        return { biased: false, combined: score.combined, rawTier };
    }

    return { biased: true, biasedTo: dominant.tier, combined: tierMidpoint(dominant.tier), rawTier };
};
