import { describe, expect, it } from "vitest";

import {
    planPause,
    RATE_LIMIT_DEFAULT_DELAY_MS,
    RATE_LIMIT_MAX_PAUSE_MS,
    RATE_LIMIT_MAX_PAUSES,
    RATE_LIMIT_MIN_DELAY_MS,
    rateLimitOf,
    toProviderRateLimit,
} from "./rate-limit-pause";

const NOW = 1_800_000_000_000;

describe("toProviderRateLimit", () => {
    it("reads the gateway's { status, retryAt }", () => {
        expect(toProviderRateLimit({ retryAt: NOW + 5000, status: 429 }, "openai")).toEqual({ provider: "openai", retryAt: NOW + 5000, status: 429 });
    });

    it("keeps a bare 429", () => {
        expect(toProviderRateLimit({ status: 429 })).toEqual({ status: 429 });
    });

    it.each([undefined, null, "429", 429, {}, { status: "429" }, { status: NaN }])("rejects %j", (value) => {
        expect(toProviderRateLimit(value)).toBeUndefined();
    });

    it("drops a retry time that is not a usable number", () => {
        expect(toProviderRateLimit({ retryAt: "soon", status: 429 })).toEqual({ status: 429 });
        expect(toProviderRateLimit({ retryAt: -1, status: 429 })).toEqual({ status: 429 });
        expect(toProviderRateLimit({ retryAt: Infinity, status: 429 })).toEqual({ status: 429 });
    });
});

describe("rateLimitOf", () => {
    const limited = Object.assign(new Error("slow down"), { rateLimit: { provider: "anthropic", retryAt: NOW + 1000, status: 429 } });

    it("reads the field off the error", () => {
        expect(rateLimitOf(limited)).toEqual({ provider: "anthropic", retryAt: NOW + 1000, status: 429 });
    });

    it("looks through a wrapping cause, as StreamFailedError does", () => {
        expect(rateLimitOf(new Error("Model stream failed", { cause: limited }))?.status).toBe(429);
    });

    it("looks through the AI SDK's RetryError.lastError", () => {
        expect(rateLimitOf(Object.assign(new Error("Failed after 3 attempts"), { lastError: limited }))?.status).toBe(429);
    });

    it("decides on the field, never on message text", () => {
        expect(rateLimitOf(new Error("Rate limit exceeded (429)"))).toBeUndefined();
        expect(rateLimitOf(Object.assign(new Error("429 Too Many Requests"), { statusCode: 429 }))).toBeUndefined();
    });

    it("does not loop on a cyclic cause chain", () => {
        const a: { cause?: unknown } = {};

        a.cause = a;

        expect(rateLimitOf(a)).toBeUndefined();
    });
});

describe("planPause", () => {
    const base = { now: NOW, pausedSteps: [] as string[], stepKey: "row-1" };

    it("pauses until the provider's retry time", () => {
        expect(planPause({ ...base, rateLimit: { retryAt: NOW + 42_000, status: 429 } })).toEqual({ pause: true, retryAt: NOW + 42_000 });
    });

    it("waits the default when the provider gave no time", () => {
        expect(planPause({ ...base, rateLimit: { status: 429 } })).toEqual({ pause: true, retryAt: NOW + RATE_LIMIT_DEFAULT_DELAY_MS });
    });

    it("never resumes sooner than the minimum delay", () => {
        expect(planPause({ ...base, rateLimit: { retryAt: NOW - 5000, status: 429 } })).toEqual({ pause: true, retryAt: NOW + RATE_LIMIT_MIN_DELAY_MS });
    });

    it("allows exactly the longest pause and refuses anything longer", () => {
        expect(planPause({ ...base, rateLimit: { retryAt: NOW + RATE_LIMIT_MAX_PAUSE_MS, status: 429 } })).toEqual({
            pause: true,
            retryAt: NOW + RATE_LIMIT_MAX_PAUSE_MS,
        });
        expect(planPause({ ...base, rateLimit: { retryAt: NOW + RATE_LIMIT_MAX_PAUSE_MS + 1, status: 429 } })).toEqual({ pause: false, reason: "too_long" });
    });

    it("refuses a step that was already paused on", () => {
        expect(planPause({ ...base, pausedSteps: ["row-1"], rateLimit: { status: 429 } })).toEqual({ pause: false, reason: "step_repeated" });
    });

    it("lets a step that Retry now cut short pause once more, and only once", () => {
        const rateLimit = { status: 429 };

        expect(planPause({ ...base, earlySteps: ["row-1"], pausedSteps: ["row-1"], rateLimit }).pause).toBe(true);
        expect(planPause({ ...base, earlySteps: ["row-1"], pausedSteps: ["row-1", "row-1"], rateLimit })).toEqual({ pause: false, reason: "step_repeated" });
        // The allowance belongs to the step it was given for.
        expect(planPause({ ...base, earlySteps: ["row-2"], pausedSteps: ["row-1"], rateLimit })).toEqual({ pause: false, reason: "step_repeated" });
    });

    it("still counts the extra pause toward the cap", () => {
        const pausedSteps = ["row-1", "row-1", "row-2"];

        expect(planPause({ ...base, earlySteps: ["row-1"], pausedSteps, rateLimit: { status: 429 }, stepKey: "row-3" })).toEqual({
            pause: false,
            reason: "too_many_pauses",
        });
    });

    it("allows the third pause and refuses the fourth", () => {
        const earlier = Array.from({ length: RATE_LIMIT_MAX_PAUSES - 1 }, (_, index) => `earlier-${index}`);

        expect(planPause({ ...base, pausedSteps: earlier, rateLimit: { status: 429 } }).pause).toBe(true);
        expect(planPause({ ...base, pausedSteps: [...earlier, "earlier-3"], rateLimit: { status: 429 } })).toEqual({ pause: false, reason: "too_many_pauses" });
    });
});
