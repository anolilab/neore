/**
 * Header-based tier override (`x-gateway-tier`).
 *
 * Lets callers explicitly bypass the heuristic scorer by asking for a
 * specific tier. The header is gated by user permissions so a free-tier
 * caller cannot self-promote to the expensive reasoning tier.
 *
 * Allowed values map onto the same enum as scoring tiers:
 *   "simple"     — Simple tier (cheapest)
 *   "standard"   — Standard tier
 *   "complex"    — Complex tier (paid users)
 *   "reasoning"  — Reasoning tier (paid users)
 *
 * Also accepts shortcuts that mirror the routingProfile enum:
 *   "fast"     → simple
 *   "balanced" → no override (heuristic scoring)
 *   "premium"  → complex
 */
import { QueryTier, TIER_ORDER, tierMidpoint } from "./tiers.js";

/** Canonical header name — must be lowercase for fetch/Hono compatibility. */
export const TIER_OVERRIDE_HEADER = "x-gateway-tier";

export type TierOverrideValue = QueryTier;

/**
 * User tiers permitted to request each routing tier. Lower tiers don't
 * cost much so we let everyone use them; the expensive complex+reasoning
 * pools require paid plans to prevent abuse of the gateway's BYO LLM
 * credits.
 */
const TIER_PERMISSIONS: Record<QueryTier, ReadonlySet<string>> = {
    [QueryTier.Complex]: new Set(["admin", "enterprise", "pro", "team"]),
    [QueryTier.Reasoning]: new Set(["admin", "enterprise", "pro", "team"]),
    [QueryTier.Simple]: new Set(["admin", "enterprise", "free", "pro", "team"]),
    [QueryTier.Standard]: new Set(["admin", "enterprise", "free", "pro", "team"]),
};

/**
 * Whether a caller on `userTier` may run `tier`. Shared with the prompt-level
 * override path so "use opus" cannot promote a free-plan caller either.
 */
export const isTierAllowedFor = (tier: QueryTier, userTier: string): boolean => TIER_PERMISSIONS[tier].has(userTier);

/** Every tier the caller's plan permits, weakest first. */
export const permittedTiersFor = (userTier: string): QueryTier[] => TIER_ORDER.filter((tier) => isTierAllowedFor(tier, userTier));

const HEADER_ALIASES: Record<string, QueryTier | "balanced"> = {
    balanced: "balanced",
    complex: QueryTier.Complex,
    fast: QueryTier.Simple,
    premium: QueryTier.Complex,
    reasoning: QueryTier.Reasoning,
    simple: QueryTier.Simple,
    standard: QueryTier.Standard,
};

export interface TierOverrideResult {
    /** Set when the header was present but rejected. */
    error?: { code: string; message: string };
    /** Parsed tier, or null if header was absent / balanced. */
    tier: QueryTier | null;
}

/**
 * Parse + validate the `x-gateway-tier` header against the caller's tier.
 * Returns the canonical QueryTier on success, or an error describing why
 * the override was rejected.
 */
export const parseTierOverride = (headerValue: string | null | undefined, userTier: string): TierOverrideResult => {
    if (!headerValue) {
        return { tier: null };
    }

    const normalised = headerValue.trim().toLowerCase();
    const resolved = HEADER_ALIASES[normalised];

    if (!resolved) {
        return {
            error: {
                code: "INVALID_TIER_OVERRIDE",
                message: `Unsupported x-gateway-tier value: '${headerValue}'. Allowed: simple, standard, complex, reasoning, fast, balanced, premium.`,
            },
            tier: null,
        };
    }

    if (resolved === "balanced") {
        return { tier: null };
    }

    const allowed = TIER_PERMISSIONS[resolved];

    if (!allowed.has(userTier)) {
        return {
            error: {
                code: "TIER_NOT_ALLOWED",
                message: `Tier '${resolved}' requires a paid plan. Upgrade your account or pick a cheaper tier.`,
            },
            tier: null,
        };
    }

    return { tier: resolved };
};

/**
 * Translate a tier into the synthetic `score.combined` value the existing
 * routing pipeline understands. The values sit comfortably inside each
 * tier's classification band (see TIER_BOUNDARIES in `tiers.ts`).
 */
export const tierToCombinedScore = (tier: QueryTier): number => tierMidpoint(tier);
