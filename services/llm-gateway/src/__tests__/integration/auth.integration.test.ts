/**
 * auth.integration.test.ts
 *
 * Integration tests for bearer token authentication on SaaS API routes.
 * Covers: missing header, wrong format, valid key (from api_key_cache),
 * revoked key, expired key, and unknown key (falls through to the backend).
 *
 * The gateway's bearerAuth middleware:
 * 1. Checks api_key_cache (WHERE key_hash = ? AND is_active = 1 AND expires_at > now)
 * 2. Falls back to the backend if not found — returns 503 when the backend is unreachable
 *
 * Revoked/expired keys are not found in cache (filtered by SQL conditions)
 * and fall through to the backend fallback, which returns 503 in test env.
 */
import { describe, expect, it, vi } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

// Mock generateText so valid-key tests don't fail on LLM calls.
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

const TEST_TOKEN = "gk_auth_integration_test_abc123";
const REVOKED_TOKEN = "gk_revoked_key_xyz789";
const EXPIRED_TOKEN = "gk_expired_key_def456";

// Minimal request body that passes schema validation
const MINIMAL_BODY = JSON.stringify({
    messages: [{ content: "hi", role: "user" }],
    model: "gpt-4o-mini",
});

const validRow = await makeVirtualKeyRow(TEST_TOKEN, { tier: "pro" });
// Revoked: is_active=0 — filtered out by SQL WHERE is_active = 1
const revokedRow = await makeVirtualKeyRow(REVOKED_TOKEN, { is_active: 0 });
// Expired: expires_at in the past — filtered out by SQL WHERE expires_at > datetime('now')
const expiredRow = await makeVirtualKeyRow(EXPIRED_TOKEN, {
    expires_at: new Date(Date.now() - 86_400_000).toISOString(), // yesterday
});

const env = createMockEnv({
    apiKeyCacheRows: [validRow, revokedRow, expiredRow],
});

const fetchApp = useTrackedAppFetch();

describe("bearerAuth integration", () => {
    it("returns 401 when Authorization header is absent", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(401);
    });

    it("returns 401 for non-Bearer Authorization header", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" }, // secret-scanner:allow — fixture credential for a 401 test, not a real key
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(401);
    });

    it("returns 401 for bearer token without gk_ prefix", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { Authorization: "Bearer sk_not_a_gateway_key", "Content-Type": "application/json" }, // secret-scanner:allow — fixture credential for a 401 test, not a real key
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string };

        expect(body.error).toContain("gk_");
    });

    it("returns 200 for a valid key found in api_key_cache", async () => {
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect(res.status).toBe(200);
    });

    it("returns 401 or 503 for a revoked key (is_active=0 filtered from cache, backend fallback)", async () => {
        // Revoked key is not returned by the cache SQL (is_active = 0 filtered out).
        // Falls through to the backend, unreachable in test env → 503.
        // In production with a reachable backend, this would return 401.
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { Authorization: `Bearer ${REVOKED_TOKEN}`, "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect([401, 503]).toContain(res.status);
    });

    it("returns 401 or 503 for an expired key (past expires_at filtered from cache, backend fallback)", async () => {
        // Expired key is not returned by the cache SQL (expires_at < now filtered out).
        // Falls through to the backend, unreachable in test env → 503.
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { Authorization: `Bearer ${EXPIRED_TOKEN}`, "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect([401, 503]).toContain(res.status);
    });

    it("returns 401 or 503 for an unknown key when the backend is unreachable", async () => {
        // Unknown token is not in api_key_cache at all; falls through to the backend
        // fetch which will fail because the URL is invalid.
        const unknownToken = "gk_unknown_not_in_db_000";
        const request = new Request("http://localhost/v1/chat/completions", {
            body: MINIMAL_BODY,
            headers: { Authorization: `Bearer ${unknownToken}`, "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await fetchApp(request, env);

        expect([401, 503]).toContain(res.status);
    });
});
