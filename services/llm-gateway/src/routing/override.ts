/**
 * Explicit tier requests written in the user's own prompt.
 *
 * The gateway already has three override channels — the `x-gateway-tier`
 * header, `routingProfile`, and `preferredModel` — but all three require the
 * caller* to set a field. None of them notices when the person typing says
 * "use opus for this" or "just use the fast model", so the heuristic scorer
 * happily overrules a decision the human already made.
 *
 * Detection is deliberately verb-anchored (`use X`, `switch to X`, `run this
 * on X`) rather than a bare keyword match: "a fast inverse square root" must
 * not route to the cheap tier. The cost of a miss is one un-honoured
 * preference; the cost of a false positive is a wrong model on every turn
 * that happens to mention a model name, so the patterns lean strict.
 *
 * A detected tier is still subject to plan permissions — see
 * `isTierAllowedFor` in `tier-override.ts`. Saying "use opus" does not
 * promote a free-plan user into the expensive pools.
 */
import { QueryTier } from "./tiers.js";

/**
 * Words that name each tier, as users actually write them: the abstract tier
 * name, the speed/cost axis, and the model families that sit in that tier
 * today. Family names are a convenience, not a contract — routing still goes
 * through the tier pools, so a request for "sonnet" means "the standard tier",
 * not "that exact model".
 */
const TIER_VOCABULARY: ReadonlyArray<{ tier: QueryTier; words: string }> = [
    { tier: QueryTier.Simple, words: "simple|fast|fastest|cheap|cheapest|small|mini|haiku|flash|lite" },
    { tier: QueryTier.Standard, words: "standard|balanced|normal|medium|sonnet" },
    { tier: QueryTier.Complex, words: "complex|strong|best|smartest|powerful|opus" },
    { tier: QueryTier.Reasoning, words: "reasoning|thinking|deep ?think" },
];

/** Verbs that mark the phrase as an instruction about the model, not prose. */
const REQUEST_VERBS = "use|using|switch to|swap to|run (?:this |it )?(?:on|with)|answer (?:this )?with|do (?:this|it) (?:on|with)";

/** Optional filler between the verb and the tier word ("use the fast model"). */
const FILLER = "(?:the |a |an )?";

/** Optional trailing noun ("use the fast model", "use haiku model"). */
const TRAILING = "(?:[- ](?:model|tier|mode))?";

const PATTERNS: ReadonlyArray<{ re: RegExp; tier: QueryTier }> = TIER_VOCABULARY.map(({ tier, words }) => {
    return {
        re: new RegExp(String.raw`\b(?:${REQUEST_VERBS})\s+${FILLER}(?:${words})${TRAILING}\b`, "i"),
        tier,
    };
});

/**
 * "think harder" and its variants are the one idiom people use without naming
 * a model at all. Treated as a request for the reasoning tier.
 */
const THINK_HARDER = /\bthink (?:a lot )?harder\b|\bthink really hard\b|\bultrathink\b/i;

/**
 * The tier the user named in their prompt, or `null` when they named none.
 *
 * When two tiers are named the *strongest* wins — "don't use haiku, use opus"
 * matches both, and honouring the weaker one is the more expensive mistake.
 */
export const detectTierOverride = (text: string): QueryTier | null => {
    if (!text) {
        return null;
    }

    let found: QueryTier | null = null;

    for (const { re, tier } of PATTERNS) {
        if (re.test(text)) {
            found = tier;
        }
    }

    if (THINK_HARDER.test(text)) {
        found = QueryTier.Reasoning;
    }

    return found;
};
