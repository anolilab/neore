/**
 * Per-minute rate limiting on Cloudflare's native Rate Limiting binding.
 *
 * A native binding fixes its limit and period, so every limit the gateway
 * enforces has its own binding (`RATE_LIMIT_<n>`, declared in `alchemy.run.ts`
 * and `wrangler.jsonc`). It writes nothing to KV, which the old counter did on
 * every request.
 *
 * The counter is local to each Cloudflare location and eventually consistent. A
 * user spread over several locations can exceed the stated RPM, and a burst can
 * pass before the counters converge. This is abuse protection, not an exact
 * budget: anything that must cap paid calls exactly needs a global check.
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
    if (!(RATE_LIMIT_VALUES as ReadonlyArray<number>).includes(limit)) {
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
