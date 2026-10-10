/**
 * Routing policy — turns a proposed tier into the tier we actually run.
 *
 * Scoring (heuristic or model-graded) answers "how hard is this turn?".
 * Policy answers the separate question "given what we already know about this
 * thread, is acting on that answer a good idea?". Three things it protects
 * against that a stateless score cannot see:
 *
 *   1. **Uncertainty is not symmetric.** Being wrong upward costs money;
 *      being wrong downward costs the user a bad answer and usually a retry
 *      on a stronger model, which costs *more* money than routing up would
 *      have. So a low-confidence verdict may never downgrade, and its upgrades
 *      are capped at `POLICY_THRESHOLDS.uncertainCeiling`.
 *
 *   2. **Switching models has a price the score doesn't include.** Providers
 *      key their prompt cache on the model, so moving tiers mid-thread
 *      re-sends the whole conversation as fresh input tokens. On a long
 *      thread that re-send can cost more than the entire saving from running
 *      the cheaper tier, which makes a "correct" downgrade a net loss.
 *
 *   3. **A tier is only a real option if something can serve it.** Plan
 *      permissions and user filter rules can empty a pool, and landing on an
 *      empty pool falls through to an arbitrary default. Clamping prefers to
 *      step *up* to the nearest usable tier, never silently down.
 *
 * The function is pure and total: every malformed or impossible input
 * resolves to the tier already in use for the thread.
 */
import { QueryTier, rankOf, TIER_ORDER } from "./tiers.js";

export const POLICY_THRESHOLDS = {
    /**
     * Above this conversation size a downgrade is refused: the prompt-cache
     * re-send it forces costs more than the cheaper tier saves on the turn.
     * Tune against observed `cache_creation` tokens if the provider mix
     * changes — the break-even moves with the price gap between tiers.
     */
    downgradeMaxContextTokens: 20_000,

    /**
     * Below this confidence we refuse to downgrade and cap upgrades at
     * `POLICY_THRESHOLDS.uncertainCeiling`. Both the heuristic scorer and the model
     * classifier report confidence on the same 0–1 scale.
     */
    minConfidence: 0.6,

    /**
     * Highest tier an unsure verdict may reach on its own. Standard is the
     * tier that completes ordinary work without reaching for the expensive
     * pools, which is the right place to land when we don't know.
     */
    uncertainCeiling: QueryTier.Standard,
} as const;

export interface PolicyInput {
    /** Tiers that are both permitted for the plan and backed by a non-empty pool. */
    available: ReadonlyArray<QueryTier>;
    /** 0–1 confidence in `target`. */
    confidence: number;
    /** Approximate size of the conversation so far, in tokens. */
    contextTokens: number;
    /** Tier this thread ran on last turn, or `null` for the first turn. */
    current: QueryTier | null;
    /** Tier the user named in their prompt, or `null`. */
    override?: QueryTier | null;
    /** Tier proposed by the classifier or the heuristic scorer. */
    target: QueryTier;
}

export interface PolicyDecision {
    /** Whether this differs from the tier the thread was already on. */
    changed: boolean;
    /** Machine-readable trace of which rule decided, for logs and telemetry. */
    reason: string;
    tier: QueryTier;
}

/**
 * Nearest tier the caller can actually run. Prefers stepping up rather than
 * down so a hard turn is never quietly handed to a weaker model.
 */
const clampToAvailable = (tier: QueryTier, available: ReadonlyArray<QueryTier>): QueryTier | null => {
    if (available.includes(tier)) {
        return tier;
    }

    const rank = rankOf(tier);
    const up = TIER_ORDER.filter((t, index) => index > rank && available.includes(t));

    if (up.length > 0) {
        return up[0]!;
    }

    const down = TIER_ORDER.filter((t, index) => index < rank && available.includes(t));

    return down.length > 0 ? down[down.length - 1]! : null;
};

export const decideTier = ({ available, confidence, contextTokens, current, override, target }: PolicyInput): PolicyDecision => {
    const settle = (tier: QueryTier, reason: string): PolicyDecision => {
        const clamped = clampToAvailable(tier, available) ?? current ?? tier;
        const why = clamped === tier ? reason : `${reason}+unavailable`;

        return {
            changed: clamped !== current,
            reason: current !== null && clamped === current ? `${why}/no-change` : why,
            tier: clamped,
        };
    };

    if (override) {
        return settle(override, "prompt-override");
    }

    // First turn in a thread: nothing to protect, and no cache to invalidate.
    if (current === null) {
        return settle(target, "initial");
    }

    if (confidence < POLICY_THRESHOLDS.minConfidence) {
        if (rankOf(target) < rankOf(current)) {
            return settle(current, "low-confidence-no-downgrade");
        }

        const ceiling = Math.max(rankOf(current), rankOf(POLICY_THRESHOLDS.uncertainCeiling));

        if (rankOf(target) > ceiling) {
            return settle(TIER_ORDER[ceiling]!, "low-confidence-capped");
        }
    }

    if (rankOf(target) < rankOf(current) && contextTokens > POLICY_THRESHOLDS.downgradeMaxContextTokens) {
        return settle(current, "downgrade-not-worth-cache-rebuild");
    }

    return settle(target, "scored");
};
