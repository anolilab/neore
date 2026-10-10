/**
 * POST /internal/generate — Non-streaming LLM call.
 *
 * Used for title generation, classification, memory extraction, and other
 * non-streaming tasks where the full response is needed at once.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { CUSTOM_PROVIDER_FORMATS } from "@neore/ai/gateway";
import { generateText } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { contextPreflight } from "../../lib/context-preflight.js";
import { GatewayError } from "../../lib/errors.js";
import type { GuardrailConfig } from "../../lib/guardrails.js";
import { parseGuardrailsConfig, scanInput } from "../../lib/guardrails.js";
import { extractTokenCounts } from "../../lib/token-counter.js";
import { internalAuth } from "../../middleware/auth.js";
import { MODEL_MAP } from "../../models.js";
import { injectPromptCaching } from "../../providers/adapters/prompt-cache.js";
import { createProviderModelForEnv, resolveApiKey } from "../../providers/factory.js";
import { ProviderHealthService } from "../../providers/health.js";
import type { ProviderOptionsMap } from "../../providers/options-filter.js";
import { filterCallParameters, filterProviderOptions, stripReasoningOptions } from "../../providers/options-filter.js";
import { calculateCost, PricingService } from "../../providers/pricing.js";
import type { ModelFilterRules } from "../../routing/filters.js";
import { getModelRejectionReason, hasActiveFilters } from "../../routing/filters.js";
import { resolveBillingMode, resolveByokFeeRate } from "../../usage/billing.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

const generateRouter = new OpenAPIHono<HonoEnv>();

// Hard upper bound on generation cost. Even an HMAC-authed caller
// (the backend agent) cannot ask the gateway to spend > this many output
// tokens in one shot. The provider-side context window is the second
// gate; this gate is purely about cost-cap.
const MAX_OUTPUT_TOKENS_HARD_CAP = 32_768;
// Cap message history at a generous-but-bounded size. The caller
// already trims via context window; this is a backstop against a
// runaway / malformed payload.
const MAX_MESSAGES_PER_REQUEST = 1000;

const requestSchema = z.object({
    /** Context window size for pre-flight token estimation. Falls back to model registry. */
    contextWindow: z.number().optional(),

    /**
     * User-defined custom provider config. Required when `provider === "custom"`.
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

    /**
     * Guardrail config. Set to false to disable (HMAC callers only).
     * Defaults to { pii: 'mask', injection: 'block' }.
     */
    guardrails: z.union([z.boolean(), z.object({ injection: z.string().optional(), pii: z.string().optional() })]).optional(),
    maxTokens: z.int().positive().max(MAX_OUTPUT_TOKENS_HARD_CAP).optional(),
    messages: z.array(z.record(z.string(), z.unknown())).max(MAX_MESSAGES_PER_REQUEST),
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
    orgId: z.string().optional(),
    provider: z.string(),
    providerApiKey: z.string().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
    system: z.string().optional(),
    temperature: z.number().optional(),
    threadId: z.string().optional(),
    /** Transforms to apply on context overflow. Supported: `"middle-out"`. */
    transforms: z.array(z.string()).optional(),
    userId: z.string(),
});

generateRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/generate",
        request: {
            body: {
                content: { "application/json": { schema: requestSchema } },
            },
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Generation result",
            },
            400: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Bad request",
            },
            401: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Unauthorized",
            },
            403: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Model blocked by filter rules",
            },
            404: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Not found",
            },
            410: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Model retired",
            },
            413: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Context window exceeded",
            },
            429: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Rate limited or budget exceeded",
            },
            500: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Internal error",
            },
            502: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Provider error",
            },
            // A GatewayError carries its own status, so every code in
            // GatewayStatusCode can reach the client from the catch below.
            // Declaring them keeps the OpenAPI contract honest — and is what
            // lets the handler's return type match the route config.
            503: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Provider not configured or unavailable",
            },
        },
        summary: "Non-streaming LLM generation",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const startTime = Date.now();

        // Validate model against filter rules before proceeding
        const filterRules = body.modelFilterRules as ModelFilterRules | undefined;

        if (hasActiveFilters(filterRules)) {
            const candidate = MODEL_MAP.get(body.modelId);

            if (candidate) {
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
        }

        const healthService = new ProviderHealthService(c.env);
        const pricingService = new PricingService(c.env);
        const usageTracker = new UsageTracker(c.env);
        const usageReporter = new UsageReporter(c.env);
        // Explicit billing flag for the usage report — see `usage/billing.ts`.
        const billingMode = resolveBillingMode({
            customBaseUrl: body.customProvider?.baseUrl,
            customFormat: body.customProvider?.format,
            isCustom: body.provider === "custom",
            providerApiKey: body.providerApiKey,
        });
        const byokFeeRate = resolveByokFeeRate(c.env.BYOK_FEE_RATE);

        // Context window pre-flight check
        const contextWindow = body.contextWindow ?? MODEL_MAP.get(body.modelId)?.contextWindow;
        let preflightMessages = body.messages as { content: unknown; role: string }[];
        const preflight = contextPreflight(preflightMessages, contextWindow, body.system, body.transforms);

        if (preflight.status === "overflow") {
            return c.json(
                {
                    error: {
                        code: "context_limit_exceeded",
                        contextWindow: preflight.contextWindow,
                        estimatedTokens: preflight.estimatedTokens,
                        message: `Estimated prompt tokens (${preflight.estimatedTokens}) exceed model context window (${preflight.contextWindow}). Use 'transforms: ["middle-out"]' to enable automatic compression.`,
                    },
                },
                413,
            );
        }

        const compressionHeaders: Record<string, string> = {};

        if (preflight.status === "compressed") {
            preflightMessages = preflight.messages;
            compressionHeaders["X-Gateway-Compressed"] = "true";
            compressionHeaders["X-Gateway-Compressed-Tokens-Before"] = String(preflight.originalTokens);
            compressionHeaders["X-Gateway-Compressed-Tokens-After"] = String(preflight.compressedTokens);
        }

        // Guardrail scan (HMAC callers may pass guardrails:false to bypass)
        const guardrailConfig: GuardrailConfig | null = parseGuardrailsConfig(body.guardrails);
        let guardrailViolationsJson: string | undefined;

        if (guardrailConfig !== null) {
            const guardrailResult = scanInput(preflightMessages as Parameters<typeof scanInput>[0], guardrailConfig);

            if (!guardrailResult.passed) {
                const isInjection = guardrailResult.violations.some((v) => v.type === "injection");

                return c.json(
                    {
                        error: {
                            code: isInjection ? "PROMPT_INJECTION_DETECTED" : "PII_DETECTED",
                            message: "Request blocked by content safety policy",
                        },
                        violations: guardrailResult.violations,
                    },
                    400,
                );
            }

            if (guardrailResult.maskedMessages) {
                preflightMessages = guardrailResult.maskedMessages as { content: unknown; role: string }[];
            }

            if (guardrailResult.violations.length > 0) {
                guardrailViolationsJson = JSON.stringify(guardrailResult.violations);
            }
        }

        try {
            const apiKey = resolveApiKey(body.provider, c.env, body.providerApiKey);
            const model = await createProviderModelForEnv(c.env, body.provider, body.modelApiId, apiKey, filterRules, body.customProvider);

            // Inject prompt caching hints for Anthropic models (90% cache discount)
            // Use pre-flight messages (may be middle-out compressed)
            const { messages: cachedMessages } = injectPromptCaching(preflightMessages as import("ai").ModelMessage[], body.provider);

            const filteredCallParams = filterCallParameters({ maxOutputTokens: body.maxTokens, temperature: body.temperature }, body.modelApiId);
            const filteredProviderOptions = stripReasoningOptions(
                filterProviderOptions(body.providerOptions as ProviderOptionsMap | undefined, body.provider),
                MODEL_MAP.get(body.modelId)?.supportsReasoning,
            );

            const result = await generateText({
                messages: cachedMessages as Parameters<typeof generateText>[0]["messages"],
                model,
                system: body.system,
                ...filteredCallParams,
                ...(filteredProviderOptions && { providerOptions: filteredProviderOptions as Parameters<typeof generateText>[0]["providerOptions"] }),
            } as Parameters<typeof generateText>[0]);

            const latencyMs = Date.now() - startTime;
            const tokens = extractTokenCounts(result.usage);

            // Calculate cost
            const pricing = await pricingService.getPricing(body.modelApiId);
            const costMicrodollars = pricing
                ? calculateCost(pricing, {
                      cachedTokens: tokens.cachedTokens,
                      completionTokens: tokens.completionTokens,
                      promptTokens: tokens.promptTokens,
                      reasoningTokens: tokens.reasoningTokens,
                  })
                : 0;

            // Record usage (non-blocking)
            c.executionCtx.waitUntil(
                Promise.allSettled([
                    usageTracker.record(
                        {
                            cachedTokens: tokens.cachedTokens,
                            completionTokens: tokens.completionTokens,
                            costMicrodollars,
                            finishReason: result.finishReason,
                            guardrailViolations: guardrailViolationsJson,
                            isStreaming: false,
                            latencyMs,
                            modelApiId: body.modelApiId,
                            modelId: body.modelId,
                            orgId: body.orgId,
                            promptTokens: tokens.promptTokens,
                            provider: body.provider,
                            reasoningTokens: tokens.reasoningTokens,
                            requestId: body.requestId,
                            source: "internal",
                            threadId: body.threadId,
                            userId: body.userId,
                        },
                        c.var.telemetry,
                    ),
                    healthService.recordSuccess(body.provider, body.modelApiId, latencyMs),
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

            const jsonResp = c.json(
                {
                    cost: {
                        microdollars: costMicrodollars,
                        pricingAvailable: pricing !== null,
                    },
                    finishReason: result.finishReason,
                    latencyMs,
                    text: result.text,
                    usage: {
                        cachedTokens: tokens.cachedTokens,
                        completionTokens: tokens.completionTokens,
                        promptTokens: tokens.promptTokens,
                        reasoningTokens: tokens.reasoningTokens,
                    },
                },
                200,
            );

            for (const [key, value] of Object.entries(compressionHeaders)) {
                jsonResp.headers.set(key, value);
            }

            return jsonResp;
        } catch (error) {
            const latencyMs = Date.now() - startTime;

            // Record failure
            c.executionCtx.waitUntil(healthService.recordFailure(body.provider, body.modelApiId));

            if (error instanceof GatewayError) {
                return c.json(error.toJSON(), error.statusCode);
            }

            return c.json(
                {
                    error: {
                        code: "PROVIDER_ERROR",
                        message: error instanceof Error ? error.message : "Unknown provider error",
                    },
                    latencyMs,
                },
                502,
            );
        }
    },
);

export { generateRouter };
