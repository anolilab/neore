/**
 * POST /internal/model/proxy — Low-level LanguageModelV3 proxy.
 *
 * Accepts serialized LanguageModelV3CallOptions, creates the real provider
 * model, and proxies doGenerate() or doStream() directly. This enables
 * the backend to use a GatewayLanguageModel adapter that implements LanguageModelV3
 * and forwards calls to the gateway without double message conversion.
 *
 * The gateway handles: provider SDK instantiation, API key resolution,
 * actual token counting, cost tracking, and usage logging.
 * The backend handles: tool execution, message persistence, multi-step loops.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { OpenAPIHono } from "@hono/zod-openapi";
import { CUSTOM_PROVIDER_FORMATS } from "@neore/ai/gateway";
import { z } from "zod";

import type { AppEnv, HonoEnv } from "../../env.js";
import { GatewayError } from "../../lib/errors.js";
import { deserializeFromWire, serializeForWire } from "../../lib/model-serialization.js";
import { internalAuth } from "../../middleware/auth.js";
import { MODEL_MAP } from "../../models.js";
import { createProviderModelForEnv, resolveApiKey } from "../../providers/factory.js";
import { ProviderHealthService } from "../../providers/health.js";
import type { ModelPricing } from "../../providers/pricing.js";
import { calculateCost, PricingService } from "../../providers/pricing.js";
import type { ModelFilterRules } from "../../routing/filters.js";
import { getModelRejectionReason, hasActiveFilters } from "../../routing/filters.js";
import type { BillingMode } from "../../usage/billing.js";
import { resolveBillingMode, resolveByokFeeRate } from "../../usage/billing.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

const modelProxyRouter = new OpenAPIHono<HonoEnv>();

/** What the gateway does around one call, decided once from the provider. */
interface ProviderPolicy {
    /** Whether the org's model filter rules apply. */
    applyFilters: boolean;
    /** The model's price, or `null` when this call is not priced by us. */
    pricing: () => Promise<ModelPricing | null>;
    /** Feeds the shared provider-health tracker. */
    recordHealth: { failure: () => Promise<void>; success: (latencyMs: number) => Promise<void> };
}

const NO_HEALTH_TRACKING: ProviderPolicy["recordHealth"] = { failure: async () => {}, success: async () => {} };

/**
 * A user's own endpoint (`custom`) is not in MODEL_MAP, not priced by us, and its
 * failures say nothing about any shared provider's health — so it gets none of
 * the three. Every other provider gets all of them.
 */
const resolveProviderPolicy = (env: AppEnv, provider: string, modelApiId: string, billingMode: BillingMode): ProviderPolicy => {
    if (provider === "custom") {
        // A custom row billed as BYOK (`resolveBillingMode`: a provider-native
        // format, or a hosted provider's host) pays a fee that is a share of the
        // model's price — so price it when the model id is one we know. An
        // Azure deployment name or unknown id prices as null: free.
        const pricing = billingMode === "byok" ? async () => await new PricingService(env).getPricing(modelApiId) : async () => null;

        return { applyFilters: false, pricing, recordHealth: NO_HEALTH_TRACKING };
    }

    const pricingService = new PricingService(env);
    const healthService = new ProviderHealthService(env);

    return {
        applyFilters: true,
        pricing: async () => await pricingService.getPricing(modelApiId),
        recordHealth: {
            failure: async () => await healthService.recordFailure(provider, modelApiId),
            success: async (latencyMs) => await healthService.recordSuccess(provider, modelApiId, latencyMs),
        },
    };
};

const proxyRequestSchema = z.object({
    action: z.enum(["generate", "stream"]),
    callOptions: z.record(z.string(), z.unknown()),

    /**
     * User-configured OpenAI-compatible endpoint. Required when
     * `provider === "custom"`; the backend resolves and decrypts it from the
     * user's `aiUserPreferences.customAIProviders`.
     */
    customProvider: z
        .object({
            accessKeyId: z.string().max(128).optional(),
            apiKey: z.string(),
            apiVersion: z.string().max(40).optional(),
            baseUrl: z.url(),
            format: z.enum(CUSTOM_PROVIDER_FORMATS),
            headers: z.record(z.string(), z.string()).optional(),
            id: z.string(),
            region: z.string().max(40).optional(),
        })
        .optional(),
    modelApiId: z.string(),

    /**
     * Model filter rules for geographic/compliance validation.
     * When set, the requested model is validated against these rules before execution.
     */
    modelFilterRules: z
        .object({
            allowedModels: z.array(z.string()).optional(),
            allowedProviders: z.array(z.string()).optional(),
            allowedRegions: z.array(z.string()).optional(),
            blockedModels: z.array(z.string()).optional(),
            blockedProviders: z.array(z.string()).optional(),
            blockedRegions: z.array(z.string()).optional(),
            denyDataCollection: z.boolean().optional(),
            requireZDR: z.boolean().optional(),
        })
        .optional(),
    modelId: z.string(),
    orgId: z.optional(z.string()),
    provider: z.string(),
    providerApiKey: z.optional(z.string()),
    // Metadata for usage tracking
    requestId: z.string(),
    threadId: z.optional(z.string()),
    userId: z.string(),
});

modelProxyRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/model/proxy",
        request: {
            body: {
                content: { "application/json": { schema: proxyRequestSchema } },
            },
        },
        responses: {
            200: {
                content: {
                    "application/json": { schema: z.record(z.string(), z.unknown()) },
                    "text/event-stream": { schema: z.string() },
                },
                description: "Model result (JSON for generate, SSE for stream)",
            },
            400: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Bad request",
            },
            502: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Provider error",
            },
        },
        summary: "Low-level LanguageModelV3 proxy (doGenerate / doStream)",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const startTime = Date.now();
        // Decided here, next to the key resolution, and carried explicitly to the
        // usage report so the backend never infers it from a key value.
        const billingMode = resolveBillingMode({
            customBaseUrl: body.customProvider?.baseUrl,
            customFormat: body.customProvider?.format,
            isCustom: body.provider === "custom",
            providerApiKey: body.providerApiKey,
        });
        const policy = resolveProviderPolicy(c.env, body.provider, body.modelApiId, billingMode);
        const byokFeeRate = resolveByokFeeRate(c.env.BYOK_FEE_RATE);

        // Validate model against filter rules before proceeding
        const filterRules = body.modelFilterRules as ModelFilterRules | undefined;

        if (policy.applyFilters && hasActiveFilters(filterRules)) {
            const candidate = MODEL_MAP.get(body.modelId);

            if (!candidate) {
                return c.json(
                    {
                        error: {
                            code: "MODEL_UNKNOWN",
                            message: `Model ${body.modelId} is not registered in the gateway and cannot be validated against filter rules`,
                        },
                    },
                    403,
                );
            }

            const rejectionReason = getModelRejectionReason(candidate, filterRules);

            if (rejectionReason) {
                return c.json(
                    {
                        error: {
                            code: "MODEL_BLOCKED",
                            message: rejectionReason,
                        },
                    },
                    403,
                );
            }
        }

        const usageTracker = new UsageTracker(c.env);
        const usageReporter = new UsageReporter(c.env);

        let apiKey: string;

        try {
            apiKey = resolveApiKey(body.provider, c.env, body.providerApiKey);
        } catch (error) {
            if (error instanceof GatewayError) {
                return c.json(error.toJSON(), error.statusCode);
            }

            return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to resolve API key" } }, 500);
        }

        try {
            const languageModel = await createProviderModelForEnv(c.env, body.provider, body.modelApiId, apiKey, filterRules, body.customProvider);

            // createProviderModel returns LanguageModel (V3 | string); assert V3 since we instantiate real models
            const model = languageModel as LanguageModelV3;

            // Deserialize call options (restores Uint8Array/URL from tagged JSON)
            const callOptions = deserializeFromWire(body.callOptions) as LanguageModelV3CallOptions;

            if (body.action === "generate") {
                // ── Non-streaming: doGenerate() ──────────────────────────
                const result = await model.doGenerate(callOptions);
                const latencyMs = Date.now() - startTime;

                // Extract usage and calculate cost
                const { usage } = result;
                const promptTokens = usage?.inputTokens?.total ?? 0;
                const completionTokens = usage?.outputTokens?.total ?? 0;
                const cachedTokens = usage?.inputTokens?.cacheRead ?? 0;
                const reasoningTokens = usage?.outputTokens?.reasoning ?? 0;

                const pricing = await policy.pricing();
                const costMicrodollars = pricing ? calculateCost(pricing, { cachedTokens, completionTokens, promptTokens, reasoningTokens }) : 0;

                // Non-blocking usage tracking
                c.executionCtx.waitUntil(
                    Promise.allSettled([
                        usageTracker.record(
                            {
                                cachedTokens,
                                completionTokens,
                                costMicrodollars,
                                finishReason: result.finishReason?.unified,
                                isStreaming: false,
                                latencyMs,
                                modelApiId: body.modelApiId,
                                modelId: body.modelId,
                                orgId: body.orgId,
                                promptTokens,
                                provider: body.provider,
                                reasoningTokens,
                                requestId: body.requestId,
                                source: "internal",
                                threadId: body.threadId,
                                userId: body.userId,
                            },
                            c.var.telemetry,
                        ),
                        policy.recordHealth.success(latencyMs),
                        usageReporter.report({
                            billingMode,
                            byokFeeRate,
                            completionTokens,
                            costMicrodollars,
                            modelId: body.modelId,
                            orgId: body.orgId,
                            promptTokens,
                            requestId: body.requestId,
                            userId: body.userId,
                        }),
                    ]),
                );

                // Serialize result for wire (converts Uint8Array back to tagged JSON)
                const serializedResult = serializeForWire(result);

                // Cost rides in headers so the body stays a plain serialized result;
                // `gateway-language-model.ts` folds it into `providerMetadata`, the same
                // place the streaming path's trailing `gateway-metadata` event lands.
                return c.json(serializedResult, 200, {
                    "x-gateway-cost-microdollars": String(costMicrodollars),
                    "x-gateway-pricing-available": String(pricing !== null),
                });
            }

            // ── Streaming: doStream() ────────────────────────────────
            const streamResult = await model.doStream(callOptions);
            let ttftMs: number | undefined;
            const execContext = c.executionCtx;

            const stream = new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    const reader = streamResult.stream.getReader();

                    let lastUsage: { cachedTokens: number; completionTokens: number; promptTokens: number; reasoningTokens: number } | undefined;
                    let lastFinishReason: string | undefined;

                    try {
                        while (true) {
                            const { done, value } = await reader.read();

                            if (done) break;

                            if (ttftMs === undefined) {
                                ttftMs = Date.now() - startTime;
                            }

                            // Track usage from finish chunk
                            if (value.type === "finish") {
                                const { usage } = value;

                                lastUsage = {
                                    cachedTokens: usage?.inputTokens?.cacheRead ?? 0,
                                    completionTokens: usage?.outputTokens?.total ?? 0,
                                    promptTokens: usage?.inputTokens?.total ?? 0,
                                    reasoningTokens: usage?.outputTokens?.reasoning ?? 0,
                                };
                                lastFinishReason = value.finishReason?.unified;
                            }

                            // Serialize the stream part (handle Uint8Array in file parts)
                            const serialized = serializeForWire(value);

                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(serialized)}\n\n`));
                        }

                        // Record usage after stream completes
                        const latencyMs = Date.now() - startTime;
                        const tokens = lastUsage ?? { cachedTokens: 0, completionTokens: 0, promptTokens: 0, reasoningTokens: 0 };

                        const pricing = await policy.pricing();
                        const costMicrodollars = pricing ? calculateCost(pricing, tokens) : 0;

                        // Send gateway metadata as final SSE event
                        const metaChunk = {
                            cost: { microdollars: costMicrodollars, pricingAvailable: pricing !== null },
                            latencyMs,
                            ttftMs,
                            type: "gateway-metadata",
                        };

                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(metaChunk)}\n\n`));

                        execContext.waitUntil(
                            Promise.allSettled([
                                usageTracker.record(
                                    {
                                        modelApiId: body.modelApiId,
                                        modelId: body.modelId,
                                        orgId: body.orgId,
                                        provider: body.provider,
                                        requestId: body.requestId,
                                        threadId: body.threadId,
                                        userId: body.userId,
                                        ...tokens,
                                        costMicrodollars,
                                        finishReason: lastFinishReason,
                                        isStreaming: true,
                                        latencyMs,
                                        source: "internal",
                                        ttftMs,
                                    },
                                    c.var.telemetry,
                                ),
                                policy.recordHealth.success(latencyMs),
                                usageReporter.report({
                                    billingMode,
                                    byokFeeRate,
                                    completionTokens: tokens.completionTokens,
                                    costMicrodollars,
                                    modelId: body.modelId,
                                    orgId: body.orgId,
                                    promptTokens: tokens.promptTokens,
                                    requestId: body.requestId,
                                    userId: body.userId,
                                }),
                            ]),
                        );
                    } catch (error) {
                        const errorChunk = {
                            error: error instanceof Error ? error.message : "Unknown stream error",
                            type: "error",
                        };

                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));

                        execContext.waitUntil(policy.recordHealth.failure());
                    } finally {
                        controller.close();
                    }
                },
            });

            return new Response(stream, {
                headers: {
                    "Cache-Control": "no-cache",
                    "Content-Type": "text/event-stream",
                    "X-Request-Id": body.requestId,
                },
                status: 200,
            });
        } catch (error) {
            c.executionCtx.waitUntil(policy.recordHealth.failure());

            if (error instanceof GatewayError) {
                return c.json(error.toJSON(), error.statusCode);
            }

            return c.json(
                {
                    error: {
                        code: "PROVIDER_ERROR",
                        message: error instanceof Error ? error.message : "Unknown provider error",
                    },
                },
                502,
            );
        }
    },
);

export { modelProxyRouter };
