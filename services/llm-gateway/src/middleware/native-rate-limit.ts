/**
 * Per-minute rate limiting on Cloudflare's native Rate Limiting binding.
 *
 * A native binding fixes its limit and period, so every limit the gateway
 * enforces has its own binding (`RATE_LIMIT_<n>`, declared in `alchemy.run.ts`
 * and `wrangler.jsonc`). The check is atomic and writes nothing to KV: the old
 * KV counter did a read, then a write, so a burst could pass the check before
 * the first write landed, and every request paid a KV read and a KV write.
 */
/** The per-minute limits the gateway enforces; each one is a binding. */
export const RATE_LIMIT_VALUES = [2, 5, 15, 20, 30, 60, 120, 600] as const;

export type RateLimitValue = (typeof RATE_LIMIT_VALUES)[number];
export type RateLimitBindingName = `RATE_LIMIT_${RateLimitValue}`;
export type RateLimitBindings = Partial<Record<RateLimitBindingName, RateLimit>>;

/**
 * Whether `key` may spend one request under a `limit`-per-minute budget.
 *
 * Returns `null` when no binding exists for `limit`: the caller fails closed
 * (503), the same as a missing KV binding did before.
 */
export const consumeRateLimit = async (env: RateLimitBindings, limit: number, key: string): Promise<boolean | null> => {
    if (!(RATE_LIMIT_VALUES as readonly number[]).includes(limit)) {
        return null;
    }

    const binding = env[`RATE_LIMIT_${limit as RateLimitValue}`];

    if (!binding) {
        return null;
    }

    const { success } = await binding.limit({ key });

    return success;
};

/** Seconds until the current minute ends, for `Retry-After`. */
export const secondsUntilNextMinute = (): number => 60 - (Math.floor(Date.now() / 1000) % 60);
