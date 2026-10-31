/**
 * When a provider rate-limits a run, the run pauses and resumes at the
 * provider's own retry time instead of failing. This is the pure half: what the
 * gateway reported, and whether the caps allow another pause.
 *
 * The gateway reads the provider's headers and body and sends `{ status, retryAt }`
 * as data (`GatewayLanguageModel` attaches it to the error as `rateLimit`).
 * Nothing here looks at message text.
 */

/** One pause lasts at most this long: a provider asking for more fails the run as before. */
export const RATE_LIMIT_MAX_PAUSE_MS = 10 * 60 * 1000;

/** A run pauses at most this many times, across all of its steps. */
export const RATE_LIMIT_MAX_PAUSES = 3;

/** The wait when a provider answered 429 without saying when to retry. */
export const RATE_LIMIT_DEFAULT_DELAY_MS = 30 * 1000;

/** A scheduled resume is queued this much after the provider's retry time, so it does not land just before the limit lifts. */
export const RATE_LIMIT_RESUME_SLACK_MS = 1500;

/** A shorter wait would only hit the same limit again; also keeps a resume off the instant it was paused. */
export const RATE_LIMIT_MIN_DELAY_MS = 1000;

/** What the gateway reported about a rejected call. */
export interface ProviderRateLimit {
    /** The provider key (`anthropic`, `openai`, …) that rejected the call. */
    provider?: string;
    /** Epoch ms the provider says to retry at; absent when it did not say. */
    retryAt?: number;
    /** The provider's HTTP status. */
    status: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * `value` as a {@link ProviderRateLimit}, or `undefined` when it is not the shape the gateway sends.
 * `provider` names the provider the call went to, unless `value` already says.
 */
export const toProviderRateLimit = (value: unknown, provider?: string): ProviderRateLimit | undefined => {
    if (!isRecord(value) || typeof value.status !== "number" || !Number.isFinite(value.status)) {
        return undefined;
    }

    const retryAt = typeof value.retryAt === "number" && Number.isFinite(value.retryAt) && value.retryAt > 0 ? value.retryAt : undefined;

    const named = typeof value.provider === "string" ? value.provider : provider;

    return { ...(named !== undefined && { provider: named }), ...(retryAt !== undefined && { retryAt }), status: value.status };
};

const CAUSE_DEPTH = 5;

/**
 * The rate limit an error carries as a `rateLimit` field, looking through the wrappers the run puts around a
 * model failure: `StreamFailedError.cause`, and the AI SDK's `RetryError.lastError`.
 */
export const rateLimitOf = (error: unknown): ProviderRateLimit | undefined => {
    let current: unknown = error;

    for (let depth = 0; depth < CAUSE_DEPTH && isRecord(current); depth += 1) {
        const found = toProviderRateLimit(current.rateLimit);

        if (found) {
            return found;
        }

        current = current.lastError ?? current.cause;
    }

    return undefined;
};

export type PauseRefusal = "step_repeated" | "too_long" | "too_many_pauses";

export type PausePlan = { pause: false; reason: PauseRefusal } | { pause: true; retryAt: number };

/**
 * Whether a run may pause for `rateLimit` now.
 *
 * - `stepKey` names the step that was rejected (the row it continues from); `pausedSteps` are the steps this run
 *   already paused on. A step that is rejected again after its pause fails: one pause per step.
 * - `earlySteps` are the steps whose pause "Retry now" cut short: the limit may not have lifted yet, so each such step
 *   may pause once more. The extra pause is in `pausedSteps` too, so the cap below still bounds it.
 * - A pause longer than {@link RATE_LIMIT_MAX_PAUSE_MS}, or a fourth one, fails the run.
 */
export const planPause = (input: {
    earlySteps?: ReadonlyArray<string>;
    now: number;
    pausedSteps: ReadonlyArray<string>;
    rateLimit: ProviderRateLimit;
    stepKey: string;
}): PausePlan => {
    const { earlySteps = [], now, pausedSteps, rateLimit, stepKey } = input;
    const retryAt = Math.max(rateLimit.retryAt ?? now + RATE_LIMIT_DEFAULT_DELAY_MS, now + RATE_LIMIT_MIN_DELAY_MS);

    if (retryAt - now > RATE_LIMIT_MAX_PAUSE_MS) {
        return { pause: false, reason: "too_long" };
    }

    const count = (steps: ReadonlyArray<string>) => steps.filter((step) => step === stepKey).length;

    if (count(pausedSteps) > count(earlySteps)) {
        return { pause: false, reason: "step_repeated" };
    }

    if (pausedSteps.length >= RATE_LIMIT_MAX_PAUSES) {
        return { pause: false, reason: "too_many_pauses" };
    }

    return { pause: true, retryAt };
};
