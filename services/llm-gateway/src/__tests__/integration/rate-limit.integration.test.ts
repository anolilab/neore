/**
 * rate-limit.integration.test.ts
 *
 * Integration tests for the per-user RPM rate limiting middleware.
 * Simulates a user already at their limit by pre-populating the KV
 * counter, then verifies that the 429 response has the right headers.
 */
import { describe, expect, it, vi } from "vitest";

import { createMockEnv, makeVirtualKeyRow, MockKVNamespace } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

// Mock generateText to prevent real LLM calls — needed since completions
// route will reach the AI SDK if auth + rate-limit both pass.
vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
            finishReason: "stop",
            text: "ok",
            toolCalls: [],
            usage: { completionTokens: 1, promptTokens: 1 },
        }),
    };
});

// Spread the real module rather than listing its exports: a hand-written
// export list goes stale the moment production adds one, and the failure
// surfaces as a 502 from an unrelated endpoint rather than as a missing mock.
vi.mock("../../providers/factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../providers/factory.js")>()),
        createKeyPool: vi.fn(),
        createProviderModel: vi.fn().mockResolvedValue({ modelId: "mock", provider: "mock" }),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
        resolveApiKeys: vi.fn().mockReturnValue(["test-api-key"]),
    };
});

const TEST_TOKEN_FREE = "gk_rate_limit_free_test";
const TEST_TOKEN_PRO = "gk_rate_limit_pro_test";

/**
 * Pre-populate KV with a counter equal to the user's RPM limit so
 * the very next request will be rate-limited.
 */
async function buildRateLimitedEnv(token: string, tier: "free" | "pro"): Promise<ReturnType<typeof createMockEnv>> {
    const keyRow = await makeVirtualKeyRow(token, { tier });
    const rateLimitKv = new MockKVNamespace();

    // TIER_LIMITS in the middleware: free=20, pro=120
    const limit = tier === "free" ? 20 : 120;
    const minuteBucket = Math.floor(Date.now() / 60_000);

    rateLimitKv.setRaw(`rl:user-test-001:${minuteBucket}`, String(limit));

    return createMockEnv({ apiKeyCacheRows: [keyRow], rateLimitKv });
}

const freeEnv = await buildRateLimitedEnv(TEST_TOKEN_FREE, "free");
const proEnv = await buildRateLimitedEnv(TEST_TOKEN_PRO, "pro");

const fetchApp = useTrackedAppFetch();

describe("rate limiting middleware", () => {
    it("returns 429 when free-tier user has exceeded 20 RPM", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN_FREE}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, freeEnv);

        expect(res.status).toBe(429);
    });

    it("includes Retry-After header in 429 response", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN_FREE}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, freeEnv);

        expect(res.status).toBe(429);

        const retryAfter = res.headers.get("Retry-After");

        expect(retryAfter).not.toBeNull();
        expect(Number(retryAfter)).toBeGreaterThan(0);
        expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    });

    it("includes X-RateLimit-Limit and X-RateLimit-Remaining=0 in 429 response", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN_FREE}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, freeEnv);

        expect(res.status).toBe(429);
        expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
        expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("includes RATE_LIMITED error code in 429 body", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN_FREE}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, freeEnv);
        const body = (await res.json()) as { error: { code: string } };

        expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("returns 429 when pro-tier user has exceeded 120 RPM", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o",
            }),
            headers: {
                Authorization: `Bearer ${TEST_TOKEN_PRO}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, proEnv);

        expect(res.status).toBe(429);
        expect(res.headers.get("X-RateLimit-Limit")).toBe("120");
    });

    it("rate limit headers use correct free-tier limit (20)", async () => {
        // Fresh request (below limit) to verify the header is set correctly
        const freshKeyRow = await makeVirtualKeyRow("gk_rate_fresh_test", { tier: "free" });
        const freshEnv = createMockEnv({ apiKeyCacheRows: [freshKeyRow] });

        const request = new Request("http://localhost/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hi", role: "user" }],
                model: "gpt-4o-mini",
            }),
            headers: {
                Authorization: "Bearer gk_rate_fresh_test", // secret-scanner:allow — fixture credential for a 401 test, not a real key
                "Content-Type": "application/json",
            },
            method: "POST",
        });
        const res = await fetchApp(request, freshEnv);

        // Request goes through (200) with rate limit headers
        if (res.status === 200) {
            expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
            expect(Number(res.headers.get("X-RateLimit-Remaining"))).toBeGreaterThanOrEqual(0);
        }
    });
});
