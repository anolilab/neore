/**
 * Canary/A-B traffic splitting for model evaluation.
 *
 * Routes a configurable percentage of traffic to a candidate model,
 * enabling cost and quality comparison before full rollout.
 * Configs stored in PRICING_KV under "canary:active" (JSON array).
 */

export interface CanaryConfig {
    canaryModelId: string;
    /** If set, canary is automatically disabled after this timestamp (ms) */
    endsAt?: number;
    id: string;
    isActive: boolean;
    /** Optional: scope canary to a specific org */
    orgId?: string;
    primaryModelId: string;
    /** 0–100: percentage of matching traffic routed to canary model */
    splitPercent: number;
    startedAt: number;
    /** Optional: scope canary to a specific user */
    userId?: string;
}

const KV_KEY = "canary:active";
/** 1-minute KV cache to avoid hot-path reads on every request */
const CACHE_TTL_S = 60;

/**
 * Load all active (non-expired) canary configs from KV.
 * Returns an empty array on any error.
 */
export const loadCanaryConfigs = async (kv: KVNamespace): Promise<CanaryConfig[]> => {
    try {
        const raw = await kv.get(KV_KEY, "json");

        if (!Array.isArray(raw)) return [];

        const now = Date.now();

        return (raw as CanaryConfig[]).filter((c) => c.isActive && (!c.endsAt || c.endsAt > now));
    } catch {
        return [];
    }
};

/**
 * Persist the full canary config array (including inactive entries) to KV.
 * Callers are responsible for merging/removing entries before calling.
 */
export const saveCanaryConfigs = async (kv: KVNamespace, configs: CanaryConfig[]): Promise<void> => {
    await kv.put(KV_KEY, JSON.stringify(configs), { expirationTtl: CACHE_TTL_S * 60 * 24 * 7 });
};

/** Uniform roll in [0, 100). */
const rollPercent = (): number => (crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32) * 100;

/**
 * Given a primary model selection, check if an active canary should override it.
 *
 * Matching rules (all must hold):
 *   1. canary.primaryModelId === primaryModelId
 *   2. canary.isActive === true and endsAt not past
 *   3. If canary.userId set, must match provided userId
 *   4. If canary.orgId set, must match provided orgId
 *   5. Random roll: rollPercent() < splitPercent
 *
 * Returns the canary modelId to use, or null to keep the primary.
 */
export const getCanaryModel = async (
    primaryModelId: string,
    userId: string | undefined,
    orgId: string | undefined,
    kv: KVNamespace,
): Promise<{ canaryId: string; modelId: string } | null> => {
    const configs = await loadCanaryConfigs(kv);

    for (const config of configs) {
        if (config.primaryModelId !== primaryModelId) continue;

        // Scope checks
        if (config.userId && config.userId !== userId) continue;

        if (config.orgId && config.orgId !== orgId) continue;

        // Statistical split
        if (rollPercent() < config.splitPercent) {
            return { canaryId: config.id, modelId: config.canaryModelId };
        }
    }

    return null;
};
