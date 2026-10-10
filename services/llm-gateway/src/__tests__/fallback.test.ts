/**
 * Unit tests for routing/fallback.ts — typed fallback chain classification and selection.
 *
 * Scope: this covers the fallback DECISION logic exhaustively — classification,
 * pre-flight, selection and error extraction. What is NOT covered anywhere is the
 * end-to-end retry: a provider returning 429/5xx and the gateway actually
 * re-issuing the call against the selected model. That needs the provider HTTP
 * layer stubbed, which the integration harness does not do today.
 *
 * There used to be an `integration/fallback.integration.test.ts` holding five
 * `it.todo`s for exactly that. It was deleted rather than kept: its header said
 * the feature was "pending implementation", which was false — `routing/fallback.ts`
 * ships and is tested right here — so it read as a much larger gap than the one
 * that exists.
 */
import { describe, expect, it, vi } from "vitest";

import { GATEWAY_MODELS } from "../models.js";
import type { ProviderHealthService } from "../providers/health.js";
import {
    classifyFailure,
    CONTENT_POLICY_FALLBACK_MODELS,
    extractProviderErrorInfo,
    selectFallback,
    shouldPreflightContextFallback,
} from "../routing/fallback.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock of ProviderHealthService that returns healthy for all models by default. */
const makeHealthService = (overrides: Record<string, boolean> = {}): ProviderHealthService =>
    ({
        getAllStatuses: vi.fn(async () => []),
        isHealthy: vi.fn(async (provider: string, modelApiId: string) => {
            const key = `${provider}:${modelApiId}`;

            return (overrides[key] as boolean | undefined) ?? true; // healthy by default
        }),
        recordFailure: vi.fn(async () => {}),
        recordSuccess: vi.fn(async () => {}),
    }) as unknown as ProviderHealthService;

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
    describe("infra fallback", () => {
        it("classifies 500 as infra", () => {
            expect(classifyFailure(500, "Internal Server Error", 100, 128_000)).toBe("infra");
        });

        it("classifies 502 as infra", () => {
            expect(classifyFailure(502, "Bad Gateway", 100, 128_000)).toBe("infra");
        });

        it("classifies 429 as infra (rate limit)", () => {
            expect(classifyFailure(429, "Rate limit exceeded", 100, 128_000)).toBe("infra");
        });

        it("classifies network timeout (0 status) as infra", () => {
            expect(classifyFailure(0, "", 100, 128_000)).toBe("infra");
        });
    });

    describe("content_policy fallback", () => {
        it("classifies 400 with content_policy keyword", () => {
            expect(classifyFailure(400, '{"error": "content_policy violation detected"}', 100, 128_000)).toBe("content_policy");
        });

        it("classifies 400 with safety keyword", () => {
            expect(classifyFailure(400, "safety filter triggered", 100, 128_000)).toBe("content_policy");
        });

        it("classifies 400 with moderation keyword", () => {
            expect(classifyFailure(400, "Request blocked by moderation system", 100, 128_000)).toBe("content_policy");
        });

        it("classifies 400 with refuse keyword", () => {
            expect(classifyFailure(400, "I refuse to generate this content", 100, 128_000)).toBe("content_policy");
        });

        it("classifies 400 with harm keyword", () => {
            expect(classifyFailure(400, "This request may cause harm", 100, 128_000)).toBe("content_policy");
        });

        it("classifies 400 with inappropriate keyword", () => {
            expect(classifyFailure(400, "Content is inappropriate", 100, 128_000)).toBe("content_policy");
        });

        it("classifies 400 with violat(ion) keyword", () => {
            expect(classifyFailure(400, "This violates our terms of service", 100, 128_000)).toBe("content_policy");
        });

        it("is case-insensitive", () => {
            expect(classifyFailure(400, "SAFETY FILTER BLOCKED", 100, 128_000)).toBe("content_policy");
        });
    });

    describe("context_overflow fallback", () => {
        it("classifies 413 as context_overflow regardless of body", () => {
            expect(classifyFailure(413, "", 100, 128_000)).toBe("context_overflow");
        });

        it("classifies 400 when promptTokens exceeds 95% of context window", () => {
            const contextWindow = 128_000;
            const promptTokens = Math.floor(contextWindow * 0.96); // 96% — over threshold

            expect(classifyFailure(400, "bad request", promptTokens, contextWindow)).toBe("context_overflow");
        });

        it("does NOT classify as context_overflow when tokens are within 95%", () => {
            const contextWindow = 128_000;
            const promptTokens = Math.floor(contextWindow * 0.94); // 94% — under threshold
            const result = classifyFailure(400, "bad request", promptTokens, contextWindow);

            // Should be infra (not content_policy, not overflow)
            expect(result).toBe("infra");
        });

        it("does NOT classify as context_overflow when contextWindow is undefined", () => {
            const result = classifyFailure(400, "bad request", 999_999, undefined);

            expect(result).toBe("infra");
        });
    });

    describe("precedence: content_policy wins over context_overflow for 400", () => {
        it("content_policy keyword takes precedence over high token count on 400", () => {
            const contextWindow = 128_000;
            const promptTokens = Math.floor(contextWindow * 0.99); // over threshold
            // Body has a safety keyword → content_policy wins
            const result = classifyFailure(400, "safety filter triggered", promptTokens, contextWindow);

            expect(result).toBe("content_policy");
        });
    });
});

// ---------------------------------------------------------------------------
// shouldPreflightContextFallback
// ---------------------------------------------------------------------------

describe("shouldPreflightContextFallback", () => {
    it("returns true when tokens exceed 95% of context window", () => {
        const contextWindow = 128_000;

        expect(shouldPreflightContextFallback(Math.floor(contextWindow * 0.96), contextWindow)).toBe(true);
    });

    it("returns false when tokens are within limit", () => {
        const contextWindow = 128_000;

        expect(shouldPreflightContextFallback(Math.floor(contextWindow * 0.94), contextWindow)).toBe(false);
    });

    it("returns false when contextWindow is undefined", () => {
        expect(shouldPreflightContextFallback(999_999, undefined)).toBe(false);
    });

    it("returns false when contextWindow is 0", () => {
        expect(shouldPreflightContextFallback(999_999, 0)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// selectFallback
// ---------------------------------------------------------------------------

describe("selectFallback", () => {
    describe("infra fallback", () => {
        it("returns a healthy model that is not the failed one", async () => {
            const hs = makeHealthService();
            const result = await selectFallback("infra", "gpt-4o", undefined, GATEWAY_MODELS, hs);

            expect(result).not.toBeNull();
            expect(result!.modelId).not.toBe("gpt-4o");
        });

        it("skips the failed model", async () => {
            const failedModelId = "gemini-2.5-flash";
            const hs = makeHealthService();
            const result = await selectFallback("infra", failedModelId, undefined, GATEWAY_MODELS, hs);

            expect(result?.modelId).not.toBe(failedModelId);
        });

        it("returns null when all models are unhealthy", async () => {
            // Mark every model as unhealthy
            const overrides: Record<string, boolean> = {};

            for (const m of GATEWAY_MODELS) {
                overrides[`${m.provider}:${m.modelApiId}`] = false;
            }

            const hs = makeHealthService(overrides);
            const result = await selectFallback("infra", "gpt-4o", undefined, GATEWAY_MODELS, hs);

            expect(result).toBeNull();
        });
    });

    describe("content_policy fallback", () => {
        it("returns one of the dedicated content-policy fallback models", async () => {
            const hs = makeHealthService();
            const result = await selectFallback("content_policy", "gpt-4o", undefined, GATEWAY_MODELS, hs);

            expect(result).not.toBeNull();
            expect(CONTENT_POLICY_FALLBACK_MODELS).toContain(result!.modelId as (typeof CONTENT_POLICY_FALLBACK_MODELS)[number]);
        });

        it("returns null when all content-policy fallback models are unhealthy", async () => {
            // Mark all content-policy fallback models as unhealthy
            const overrides: Record<string, boolean> = {};

            for (const modelId of CONTENT_POLICY_FALLBACK_MODELS) {
                const candidate = GATEWAY_MODELS.find((m) => m.modelId === modelId);

                if (candidate) overrides[`${candidate.provider}:${candidate.modelApiId}`] = false;
            }

            const hs = makeHealthService(overrides);
            const result = await selectFallback("content_policy", "gpt-4o", undefined, GATEWAY_MODELS, hs);

            expect(result).toBeNull();
        });

        it("does not fall back to the failed model", async () => {
            // If the failed model is mistral-nemo, should try llama-4-scout
            const hs = makeHealthService();
            const result = await selectFallback("content_policy", "mistral-nemo", undefined, GATEWAY_MODELS, hs);

            expect(result?.modelId).not.toBe("mistral-nemo");
        });
    });

    describe("context_overflow fallback", () => {
        it("returns a model with contextWindow >= 2x the failed model's window", async () => {
            const failedContextWindow = 128_000;
            const hs = makeHealthService();
            const result = await selectFallback("context_overflow", "gpt-4o", failedContextWindow, GATEWAY_MODELS, hs);

            expect(result).not.toBeNull();
            expect(result!.contextWindow ?? 0).toBeGreaterThanOrEqual(failedContextWindow * 2);
        });

        it("returns a model with contextWindow >= 500K minimum when failed model has small window", async () => {
            const failedContextWindow = 10_000; // hypothetical tiny model
            const hs = makeHealthService();
            const result = await selectFallback("context_overflow", "tiny-model", failedContextWindow, GATEWAY_MODELS, hs);

            expect(result).not.toBeNull();
            expect(result!.contextWindow ?? 0).toBeGreaterThanOrEqual(500_000);
        });

        it("prefers the largest context window model", async () => {
            // gemini-2.5-pro and gpt-4.1 both have 1M context — should pick one of them
            const failedContextWindow = 128_000;
            const hs = makeHealthService();
            const result = await selectFallback("context_overflow", "gpt-4o", failedContextWindow, GATEWAY_MODELS, hs);

            expect(result).not.toBeNull();
            // Should be a million-token model
            expect(result!.contextWindow ?? 0).toBeGreaterThanOrEqual(1_000_000);
        });

        it("returns null when no model has a large enough context window", async () => {
            // Make all large-context models unhealthy
            const largeContextModels = GATEWAY_MODELS.filter((m) => (m.contextWindow ?? 0) >= 500_000);
            const overrides: Record<string, boolean> = {};

            for (const m of largeContextModels) {
                overrides[`${m.provider}:${m.modelApiId}`] = false;
            }

            const hs = makeHealthService(overrides);
            // Failed model with 128K window — needs >= 256K
            const result = await selectFallback("context_overflow", "gpt-4o", 128_000, GATEWAY_MODELS, hs);

            expect(result).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// extractProviderErrorInfo
// ---------------------------------------------------------------------------

describe("extractProviderErrorInfo", () => {
    it("extracts statusCode and responseBody from AI SDK APICallError shape", () => {
        const error = { responseBody: '{"error": "rate limited"}', statusCode: 429 };
        const result = extractProviderErrorInfo(error);

        expect(result.statusCode).toBe(429);
        expect(result.body).toBe('{"error": "rate limited"}');
    });

    it("falls back to error.message when responseBody is absent", () => {
        const error = { message: "content policy violation", statusCode: 400 };
        const result = extractProviderErrorInfo(error);

        expect(result.statusCode).toBe(400);
        expect(result.body).toBe("content policy violation");
    });

    it("returns defaults for non-object errors", () => {
        expect(extractProviderErrorInfo("string error")).toEqual({ body: "", statusCode: 500 });
        expect(extractProviderErrorInfo(null)).toEqual({ body: "", statusCode: 500 });
        expect(extractProviderErrorInfo(undefined)).toEqual({ body: "", statusCode: 500 });
    });

    it("defaults statusCode to 500 when not a number", () => {
        const error = { message: "error", statusCode: "bad" };
        const result = extractProviderErrorInfo(error);

        expect(result.statusCode).toBe(500);
    });
});
