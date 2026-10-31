/**
 * `readRateLimit` turns a provider rejection into the structured `{ status, retryAt }`
 * the backend pauses a run on. The shapes below are the ones the supported
 * providers actually send: their headers, their JSON bodies, and the AI SDK's
 * `APICallError` that carries both.
 */
import { describe, expect, it } from "vitest";

import { parseDuration, readRateLimit } from "../lib/retry-after.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

/** A provider rejection shaped like the AI SDK's `APICallError`. */
const rejection = (statusCode: number | undefined, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
    Object.assign(
        new Error("rejected"),
        statusCode !== undefined && { statusCode },
        init.headers && { responseHeaders: init.headers },
        init.body !== undefined && {
            responseBody: typeof init.body === "string" ? init.body : JSON.stringify(init.body),
        },
    );

describe("parseDuration", () => {
    it.each([
        ["1s", 1000],
        ["1.5s", 1500],
        ["20ms", 20],
        ["6m0s", 360_000],
        ["1h2m3s", 3_723_000],
        ["34.123s", 34_123],
    ])("%s is %i ms", (text, expected) => {
        expect(parseDuration(text)).toBe(expected);
    });

    it.each(["", "soon", "12", "-3s"])("%j is not a duration", (text) => {
        expect(parseDuration(text)).toBeUndefined();
    });
});

describe("readRateLimit: headers", () => {
    it("reads retry-after in seconds", () => {
        expect(readRateLimit(rejection(429, { headers: { "retry-after": "30" } }), NOW)).toEqual({ retryAt: NOW + 30_000, status: 429 });
    });

    it("reads retry-after as an HTTP date", () => {
        const date = new Date(NOW + 90_000).toUTCString();

        expect(readRateLimit(rejection(429, { headers: { "retry-after": date } }), NOW)).toEqual({ retryAt: NOW + 90_000, status: 429 });
    });

    it("reads retry-after-ms and prefers it over retry-after", () => {
        expect(readRateLimit(rejection(429, { headers: { "retry-after": "30", "retry-after-ms": "1500" } }), NOW)).toEqual({
            retryAt: NOW + 1500,
            status: 429,
        });
    });

    it("matches header names without regard to case", () => {
        expect(readRateLimit(rejection(429, { headers: { "Retry-After": "4" } }), NOW)).toEqual({ retryAt: NOW + 4000, status: 429 });
    });

    it("reads an OpenAI/Groq duration reset for the limit that is exhausted", () => {
        const headers = {
            "x-ratelimit-remaining-requests": "59",
            "x-ratelimit-remaining-tokens": "0",
            "x-ratelimit-reset-requests": "1s",
            "x-ratelimit-reset-tokens": "6m0s",
        };

        expect(readRateLimit(rejection(429, { headers }), NOW)).toEqual({ retryAt: NOW + 360_000, status: 429 });
    });

    it("reads an Anthropic RFC 3339 reset for the limit that is exhausted", () => {
        const reset = new Date(NOW + 45_000).toISOString();
        const headers = {
            "anthropic-ratelimit-requests-remaining": "10",
            "anthropic-ratelimit-requests-reset": new Date(NOW + 5000).toISOString(),
            "anthropic-ratelimit-tokens-remaining": "0",
            "anthropic-ratelimit-tokens-reset": reset,
        };

        expect(readRateLimit(rejection(429, { headers }), NOW)).toEqual({ retryAt: NOW + 45_000, status: 429 });
    });

    it("ignores a reset whose limit still has room", () => {
        const headers = { "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "20s" };

        expect(readRateLimit(rejection(429, { headers }), NOW)).toEqual({ status: 429 });
    });
});

describe("readRateLimit: provider bodies", () => {
    it("reads Google's RetryInfo.retryDelay", () => {
        const body = {
            error: {
                code: 429,
                details: [
                    { "@type": "type.googleapis.com/google.rpc.QuotaFailure" },
                    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" },
                ],
                status: "RESOURCE_EXHAUSTED",
            },
        };

        expect(readRateLimit(rejection(429, { body }), NOW)).toEqual({ retryAt: NOW + 34_000, status: 429 });
    });

    it("reads OpenRouter's X-RateLimit-Reset (epoch ms) from the error metadata", () => {
        const body = { error: { code: 429, message: "Rate limit exceeded", metadata: { headers: { "X-RateLimit-Reset": String(NOW + 12_000) } } } };

        expect(readRateLimit(rejection(429, { body }), NOW)).toEqual({ retryAt: NOW + 12_000, status: 429 });
    });

    it("reads the wait an OpenAI-style message names", () => {
        const body = { error: { code: "rate_limit_exceeded", message: "Rate limit reached for gpt-4o. Please try again in 7.66s.", type: "tokens" } };

        expect(readRateLimit(rejection(429, { body }), NOW)).toEqual({ retryAt: NOW + 7660, status: 429 });
    });

    it("reads a millisecond wait in a message", () => {
        const body = { error: { message: "Please try again in 820ms." } };

        expect(readRateLimit(rejection(429, { body }), NOW)).toEqual({ retryAt: NOW + 820, status: 429 });
    });

    it("prefers a header over the body", () => {
        const body = { error: { details: [{ retryDelay: "34s" }] } };

        expect(readRateLimit(rejection(429, { body, headers: { "retry-after": "2" } }), NOW)).toEqual({ retryAt: NOW + 2000, status: 429 });
    });

    it("survives a body that is not JSON", () => {
        expect(readRateLimit(rejection(429, { body: "<html>slow down</html>" }), NOW)).toEqual({ status: 429 });
    });
});

describe("readRateLimit: what counts", () => {
    it("reports a 429 without a retry time (the backend picks a default)", () => {
        expect(readRateLimit(rejection(429), NOW)).toEqual({ status: 429 });
    });

    it("reads the status from `status` too", () => {
        expect(readRateLimit(Object.assign(new Error("slow"), { status: 429 }), NOW)).toEqual({ status: 429 });
    });

    it("reports a 5xx only when it carries a retry time", () => {
        expect(readRateLimit(rejection(503, { headers: { "retry-after": "10" } }), NOW)).toEqual({ retryAt: NOW + 10_000, status: 503 });
        expect(readRateLimit(rejection(503), NOW)).toBeUndefined();
        expect(readRateLimit(rejection(529, { headers: { "retry-after": "3" } }), NOW)).toEqual({ retryAt: NOW + 3000, status: 529 });
    });

    it("ignores a 4xx that is not a rate limit, even with a retry-after", () => {
        expect(readRateLimit(rejection(400, { headers: { "retry-after": "10" } }), NOW)).toBeUndefined();
        expect(readRateLimit(rejection(401), NOW)).toBeUndefined();
    });

    it("reads a throttling error that carries no status from its structured code", () => {
        expect(readRateLimit({ error: { code: "rate_limit_exceeded", message: "Please try again in 2s" } }, NOW)).toEqual({ retryAt: NOW + 2000, status: 429 });
        expect(readRateLimit({ error: { type: "rate_limit_error" } }, NOW)).toEqual({ status: 429 });
        expect(readRateLimit({ message: "throttled", name: "ThrottlingException" }, NOW)).toEqual({ status: 429 });
    });

    it("does not mistake a message that merely says 'rate limit' for one", () => {
        expect(readRateLimit(new Error("rate limit mentioned in passing"), NOW)).toBeUndefined();
    });

    it("returns nothing for what is not an object", () => {
        expect(readRateLimit(undefined, NOW)).toBeUndefined();
        expect(readRateLimit("429", NOW)).toBeUndefined();
    });

    it("never returns a time in the past", () => {
        expect(readRateLimit(rejection(429, { headers: { "retry-after": "0" } }), NOW)).toEqual({ retryAt: NOW, status: 429 });
        expect(readRateLimit(rejection(429, { headers: { "retry-after": new Date(NOW - 60_000).toUTCString() } }), NOW)).toEqual({ retryAt: NOW, status: 429 });
    });
});
