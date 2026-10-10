/**
 * cache.integration.test.ts
 *
 * Integration tests for cache management endpoints:
 *   GET  /v1/cache/stats  — binding-only (the backend's `InternalApi` entrypoint)
 *   DELETE /v1/cache      — binding-only
 *
 * Also tests that the PromptCache correctly identifies cacheable vs.
 * non-cacheable requests (unit-level but included here for coverage).
 */
import { describe, expect, it } from "vitest";

import { isCacheable } from "../../lib/prompt-cache.js";
import { bindingEnv, makeInternalRequest } from "../helpers/internal.js";
import { createMockEnv } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const PUBLIC_ENV = createMockEnv({ nodeEnv: "test" });
/** The env the `InternalApi` entrypoint (the backend's binding) runs the app with. */
const ENV = bindingEnv(PUBLIC_ENV);

const fetchApp = useTrackedAppFetch();

describe("GET /v1/cache/stats (binding-only)", () => {
    it("returns 200 with stats shape through the binding", async () => {
        const request = makeInternalRequest("GET", "/v1/cache/stats?period=24h");
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = await res.json();

        expect(body).toHaveProperty("period");
        expect(body).toHaveProperty("hits");
        expect(body).toHaveProperty("misses");
        expect(body).toHaveProperty("hitRate");
        expect(body).toHaveProperty("savedTokens");
        expect(body).toHaveProperty("savedCostMicrodollars");
    });

    it("returns 404 to a public request (not through the binding)", async () => {
        const request = new Request("http://localhost/v1/cache/stats");
        const res = await fetchApp(request, PUBLIC_ENV);

        expect(res.status).toBe(404);
    });

    it("accepts 7d period parameter", async () => {
        const request = makeInternalRequest("GET", "/v1/cache/stats?period=7d");
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { period: string };

        expect(body.period).toBe("7d");
    });
});

describe("DELETE /v1/cache (binding-only)", () => {
    it("returns 200 with flushed=true through the binding", async () => {
        const request = makeInternalRequest("DELETE", "/v1/cache");
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { deleted: number; flushed: boolean };

        expect(body.flushed).toBe(true);
        expect(typeof body.deleted).toBe("number");
    });

    it("returns 404 to a public request (not through the binding)", async () => {
        const request = new Request("http://localhost/v1/cache", { method: "DELETE" });
        const res = await fetchApp(request, PUBLIC_ENV);

        expect(res.status).toBe(404);
    });
});

describe("PromptCache.isCacheable()", () => {
    const baseRequest = {
        messages: [{ content: "hello", role: "user" }],
        modelApiId: "gpt-4o-mini",
        modelId: "gpt-4o-mini",
    };

    it("is cacheable for temperature=0 requests without tools", () => {
        expect(isCacheable({ ...baseRequest, temperature: 0 }, false)).toBe(true);
    });

    it("is cacheable when temperature is absent (defaults to 0)", () => {
        expect(isCacheable(baseRequest, false)).toBe(true);
    });

    it("is NOT cacheable when temperature > 0", () => {
        expect(isCacheable({ ...baseRequest, temperature: 0.7 }, false)).toBe(false);
    });

    it("is NOT cacheable when tool schemas are provided", () => {
        expect(isCacheable({ ...baseRequest, toolCount: 1 }, false)).toBe(false);
    });

    it("is NOT cacheable when cache bypass flag is set", () => {
        expect(isCacheable(baseRequest, true)).toBe(false);
    });
});
