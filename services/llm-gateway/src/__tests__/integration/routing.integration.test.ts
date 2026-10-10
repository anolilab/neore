/**
 * routing.integration.test.ts
 *
 * Integration tests for POST /internal/route — smart model selection.
 * Verifies that different query types are classified into the correct tiers,
 * the response shape is correct, and the route is binding-only.
 */
import { describe, expect, it } from "vitest";

import { bindingEnv, makeInternalRequest } from "../helpers/internal.js";
import { createMockEnv } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const PUBLIC_ENV = createMockEnv({ nodeEnv: "test" });
/** The env the `InternalApi` entrypoint (the backend's binding) runs the app with. */
const ENV = bindingEnv(PUBLIC_ENV);

const signedRoute = (body: unknown) => makeInternalRequest("POST", "/internal/route", JSON.stringify(body));

const fetchApp = useTrackedAppFetch();

describe("POST /internal/route (smart routing)", () => {
    it("returns 404 to a public request (not through the binding)", async () => {
        const request = makeInternalRequest("POST", "/internal/route", JSON.stringify({ messages: [{ content: "hi", role: "user" }] }));
        const res = await fetchApp(request, PUBLIC_ENV);

        expect(res.status).toBe(404);
    });

    it("returns 200 with routing decision shape for a valid request", async () => {
        const request = signedRoute({
            messages: [{ content: "What is 2+2?", role: "user" }],
            userTier: "pro",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as {
            confidence: unknown;
            fromCache: unknown;
            modelApiId: unknown;
            modelId: unknown;
            provider: unknown;
            routingReason: unknown;
            tier: unknown;
        };

        expect(typeof body.modelId).toBe("string");
        expect(typeof body.provider).toBe("string");
        expect(typeof body.modelApiId).toBe("string");
        expect(typeof body.tier).toBe("string");
        expect(typeof body.confidence).toBe("number");
        expect(typeof body.routingReason).toBe("string");
        expect(typeof body.fromCache).toBe("boolean");
    });

    it("classifies a simple greeting as 'simple' tier", async () => {
        const request = signedRoute({
            messages: [{ content: "hi", role: "user" }],
            userTier: "free",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { score: { combined: number }; tier: string };

        expect(body.tier).toBe("simple");
        expect(body.score.combined).toBeLessThanOrEqual(0.25);
    });

    it("classifies a complex reasoning query above simple tier", async () => {
        // Message crafted to hit MATH_PATTERNS (integral, theorem), CODE_PATTERNS
        // (function), and REASONING_PATTERNS (step by step, analyze), ensuring a
        // combined score well above the 0.25 simple/standard boundary.
        const request = signedRoute({
            messages: [
                {
                    content:
                        "Write a Python function to solve differential equations step by step. Analyze the integral theorem mathematically and evaluate each approach.",
                    role: "user",
                },
            ],
            userTier: "pro",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { score: { combined: number }; tier: string };

        expect(["standard", "complex", "reasoning"]).toContain(body.tier);
        expect(body.score.combined).toBeGreaterThan(0.25);
    });

    it("respects 'fast' routing profile — always returns simple tier", async () => {
        const request = signedRoute({
            messages: [
                {
                    content: "Explain the entire history of computer science with detailed analysis.",
                    role: "user",
                },
            ],
            routingProfile: "fast",
            userTier: "pro",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { tier: string };

        expect(body.tier).toBe("simple");
    });

    it("respects 'reasoning' routing profile — always returns reasoning tier", async () => {
        // Use a distinct message to avoid PRICING_KV cache collision with the
        // "What is 2+2?" message used in other tests (which may cache as "simple").
        const request = signedRoute({
            messages: [{ content: `Unique reasoning profile test: ${crypto.randomUUID()}`, role: "user" }],
            routingProfile: "reasoning",
            userTier: "enterprise",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { tier: string };

        expect(body.tier).toBe("reasoning");
    });

    it("includes score breakdown in response", async () => {
        const request = signedRoute({
            messages: [{ content: "Write a TypeScript function that sorts a list", role: "user" }],
            userTier: "pro",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { score: unknown };

        expect(body.score).toHaveProperty("combined");
        expect(body.score).toHaveProperty("complexity");
        expect(body.score).toHaveProperty("codeGeneration");
        expect(body.score).toHaveProperty("reasoning");
        expect(body.score).toHaveProperty("contextLength");
        expect(body.score).toHaveProperty("toolUse");
    });

    it("sets fromCache=false on first request (KV is empty)", async () => {
        const request = signedRoute({
            messages: [{ content: `unique message ${crypto.randomUUID()}`, role: "user" }],
            userTier: "pro",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { fromCache: boolean };

        expect(body.fromCache).toBe(false);
    });

    it("respects preferredModel when that model is healthy", async () => {
        const request = signedRoute({
            messages: [{ content: "hello", role: "user" }],
            preferredModel: "gpt-4o",
            userTier: "pro",
        });
        const res = await fetchApp(request, ENV);

        expect(res.status).toBe(200);

        const body = (await res.json()) as { modelId: string };

        expect(body.modelId).toBe("gpt-4o");
    });
});
