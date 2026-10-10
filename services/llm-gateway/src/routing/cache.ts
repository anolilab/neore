/**
 * Classifier verdict cache.
 *
 * What is worth caching on the routing path is the *model-graded verdict* —
 * the only step that costs a network round-trip. Everything downstream of it
 * (momentum, policy, filters, pins, health, pricing) is local arithmetic in
 * the microsecond range, and all of it is user-specific.
 *
 * Caching the finished routing decision instead is actively unsafe: the
 * decision embodies the caller's plan, region and provider filter rules, and
 * category pins, so serving one caller's decision to another silently applies
 * the wrong restrictions. Caching only the verdict removes that failure mode
 * by construction — the cached artifact says "text of this shape reads as
 * tier X", which is true regardless of who asked.
 *
 * The key still includes the tier set the verdict was produced against,
 * because the classifier is only ever offered the tiers the caller can
 * actually run and its answer is relative to that menu.
 */
import type { QueryTier } from "./tiers.js";

/** 5 minutes. Long enough to absorb a retry storm, short enough to follow prompt edits. */
const VERDICT_CACHE_TTL_SECONDS = 300;

/** Prompt prefix length folded into the key. */
const MAX_KEY_CONTENT_LENGTH = 400;

export interface CachedVerdict {
    confidence: number;
    tier: QueryTier;
}

export interface VerdictCacheKeyInput {
    availableTiers: ReadonlyArray<QueryTier>;
    hasImages: boolean;
    lastUserMessage: string;
    toolCount: number;
}

/**
 * SHA-256 over the key material.
 *
 * The previous implementation used a 32-bit string hash, which is not a safe
 * basis for a shared cache: a collision serves an unrelated entry, and 32 bits
 * is small enough for that to happen by accident at gateway traffic volumes.
 */
const digest = async (raw: string): Promise<string> => {
    const bytes = new TextEncoder().encode(raw);
    const hash = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const buildKey = async (input: VerdictCacheKeyInput): Promise<string> => {
    // JSON encoding keeps the fields unambiguous without needing a separator
    // that the prompt text itself could contain.
    const material = JSON.stringify([
        input.lastUserMessage.slice(0, MAX_KEY_CONTENT_LENGTH),
        input.toolCount,
        input.hasImages,
        input.availableTiers.toSorted((a, b) => a.localeCompare(b)),
    ]);

    return `verdict:${await digest(material)}`;
};

export class VerdictCache {
    private kv: KVNamespace;

    constructor(kv: KVNamespace) {
        this.kv = kv;
    }

    /** Previously computed verdict for this prompt shape, or `null`. */
    async get(input: VerdictCacheKeyInput): Promise<CachedVerdict | null> {
        try {
            return (await this.kv.get(await buildKey(input), "json")) as CachedVerdict | null;
        } catch {
            return null;
        }
    }

    /** Store a verdict. Best-effort — a cache write must never fail a request. */
    async put(input: VerdictCacheKeyInput, verdict: CachedVerdict): Promise<void> {
        try {
            await this.kv.put(await buildKey(input), JSON.stringify(verdict), { expirationTtl: VERDICT_CACHE_TTL_SECONDS });
        } catch {
            // Non-critical.
        }
    }
}
