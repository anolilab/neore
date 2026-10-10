/**
 * POST /internal/stream — Streaming LLM call.
 *
 * Proxies AI SDK streamText through the gateway, emitting SSE chunks
 * back to the backend. Records actual token usage and cost after completion.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { CUSTOM_PROVIDER_FORMATS } from "@neore/ai/gateway";
import { streamText } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { contextPreflight } from "../../lib/context-preflight.js";
import type { ErrorCode } from "../../lib/errors.js";
import { enrichError, GatewayError } from "../../lib/errors.js";
import type { GuardrailConfig } from "../../lib/guardrails.js";
import { parseGuardrailsConfig, scanInput } from "../../lib/guardrails.js";
import { DEFAULT_PEEK_TIMEOUT_MS, peekStream } from "../../lib/peek-stream.js";
import { formatSSE, streamToSSE } from "../../lib/stream-adapter.js";
import { extractTokenCounts } from "../../lib/token-counter.js";
import { toToolSet } from "../../lib/tool-set.js";
import { internalAuth } from "../../middleware/auth.js";
import { MODEL_MAP } from "../../models.js";
import { injectPromptCaching } from "../../providers/adapters/prompt-cache.js";
import type { ToolDefinition } from "../../providers/adapters/types.js";
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

const streamRouter = new OpenAPIHono<HonoEnv>();

// Hard upper bound on generation cost (matches generate.ts). Backstop
// against malformed or hostile callers asking for absurd token counts.
const MAX_OUTPUT_TOKENS_HARD_CAP = 32_768;
const MAX_MESSAGES_PER_REQUEST = 1000;

/** Matches a complete single-event SSE frame, capturing its `data:` payload. */
const SSE_SINGLE_EVENT_RE = /^data: (.+)\n\n$/;

const requestSchema = z.object({
    /** Context window size for pre-flight token estimation. Falls back to model registry. */
    contextWindow: z.number().optional(),

    /**
     * User-defined custom provider config. Required when `provider === "custom"`.
     * Lets clients plug in any OpenAI/Anthropic-compatible endpoint
     * (self-hosted vLLM, enterprise gateway, Together, Fireworks, etc.).
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
    toolSchemas: z.record(z.string(), z.object({ description: z.string(), parameters: z.record(z.string(), z.unknown()) })).optional(),
    /** Transforms to apply on context overflow. Supported: `"middle-out"`. */
    transforms: z.array(z.string()).optional(),
    userId: z.string(),

    /**
     * Stream warm-up timeout in ms. Defaults to 15 000.
     * If no chunk arrives before the deadline (or the stream errors / closes
     * empty), the gateway returns a structured 502 with `STREAM_WARMUP_*` so
     * the caller can fall back to a different model before any bytes are
     * written. Set to 0 to disable warm-up entirely.
     */
    warmupTimeoutMs: z.int().nonnegative().max(60_000).optional(),
});

streamRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/stream",
        request: {
            body: {
                content: { "application/json": { schema: requestSchema } },
            },
        },
        responses: {
            200: {
                content: { "text/event-stream": { schema: z.string() } },
                description: "SSE stream of generation chunks",
            },
            400: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Bad request",
            },
            403: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Model blocked by filter rules",
            },
            413: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Context window exceeded",
            },
            502: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Provider error",
            },
        },
        summary: "Streaming LLM generation",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const startTime = Date.now();

        // Validate model against filter rules before proceeding
        const filterRules = body.modelFilterRules as ModelFilterRules | undefined;

        if (hasActiveFilters(filterRules)) {
            const candidate = MODEL_MAP.get(body.modelId);

            if (!candidate) {
                // Fail closed when filter rules are active and we cannot
                // confirm compliance for the requested modelId. Otherwise a
                // typo or unregistered model name would silently bypass
                // user-configured restrictions.
                return c.json(
                    {
                        error: {
                            code: "MODEL_UNKNOWN",
                            message: `Cannot validate compliance for unknown modelId: ${body.modelId}`,
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

        let apiKey: string;

        try {
            apiKey = resolveApiKey(body.provider, c.env, body.providerApiKey);
        } catch (error) {
            if (error instanceof GatewayError) {
                return c.json(error.toJSON(), error.statusCode);
            }

            return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to resolve API key" } }, 500);
        }

        // Convert tool schemas to AI SDK format
        const tools: Record<string, { description: string; parameters: unknown }> = {};
        const toolDefs: ToolDefinition[] = [];

        if (body.toolSchemas) {
            for (const [name, schema] of Object.entries(body.toolSchemas)) {
                tools[name] = {
                    description: schema.description,
                    parameters: schema.parameters,
                };
                toolDefs.push({ description: schema.description, name, parameters: schema.parameters });
            }
        }

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
            const model = await createProviderModelForEnv(c.env, body.provider, body.modelApiId, apiKey, filterRules, body.customProvider);

            // Inject prompt caching hints for Anthropic models (90% cache discount)
            // Use pre-flight messages (may be middle-out compressed)
            const messages = preflightMessages as Parameters<typeof streamText>[0]["messages"];
            const { messages: cachedMessages, tools: cachedTools } = injectPromptCaching(
                messages as import("ai").ModelMessage[],
                body.provider,
                toolDefs.length > 0 ? toolDefs : undefined,
            );

            // Filter call parameters and provider options so this attempt
            // never carries leftover keys from a different provider (cross-
            // provider fall-back) or rejected keys for reasoning-only models.
            const filteredCallParams = filterCallParameters({ maxOutputTokens: body.maxTokens, temperature: body.temperature }, body.modelApiId);
            // Keyed by tool name with a real inputSchema — see lib/tool-set.ts
            // for why passing the definition array straight through silently
            // produces tools the model can never call.
            const toolSet = toToolSet(cachedTools);
            const filteredProviderOptions = stripReasoningOptions(
                filterProviderOptions(body.providerOptions as ProviderOptionsMap | undefined, body.provider),
                MODEL_MAP.get(body.modelId)?.supportsReasoning,
            );

            const result = streamText({
                messages: cachedMessages as Parameters<typeof streamText>[0]["messages"],
                model,
                system: body.system,
                ...filteredCallParams,
                ...(filteredProviderOptions && { providerOptions: filteredProviderOptions as Parameters<typeof streamText>[0]["providerOptions"] }),
                // Pass tools through so the LLM can actually emit tool_calls.
                // Without this, callers asking for agentic behavior silently
                // got text-only responses with no error signal.
                ...(toolSet && { tools: toolSet }),
            } as Parameters<typeof streamText>[0]);

            // ── Stream warm-up ───────────────────────────────────────────
            // Peek the first chunk before committing to the 200 SSE response
            // so a model that opens the connection but never produces a
            // token doesn't waste the caller's only attempt. Failure here
            // surfaces as a structured 502 the routing layer can fall back
            // on. `warmupTimeoutMs === 0` disables the peek entirely.
            const warmupTimeoutMs = body.warmupTimeoutMs ?? DEFAULT_PEEK_TIMEOUT_MS;
            const sseIterable = streamToSSE(result);
            const sseIterator = sseIterable[Symbol.asyncIterator]();

            let firstChunk: string | undefined;
            let warmupElapsedMs = 0;

            if (warmupTimeoutMs > 0) {
                const peek = await peekStream(sseIterator, warmupTimeoutMs);

                // streamToSSE catches provider errors and yields them as a
                // typed SSE `error` chunk rather than throwing — detect that
                // case here so warm-up still surfaces the failure as 502 JSON.
                let earlyErrorMessage: string | undefined;

                if (peek.ok) {
                    const match = SSE_SINGLE_EVENT_RE.exec(peek.first);

                    if (match) {
                        try {
                            const parsed = JSON.parse(match[1]!) as { error?: { message?: string }; type?: string };

                            if (parsed.type === "error") {
                                earlyErrorMessage = parsed.error?.message ?? "Provider error before first token";
                            }
                        } catch {
                            // Non-JSON payload — treat as a real first chunk.
                        }
                    }
                }

                if (earlyErrorMessage !== undefined || !peek.ok) {
                    c.executionCtx.waitUntil(healthService.recordFailure(body.provider, body.modelApiId));

                    const reason = peek.ok ? "error" : peek.reason;

                    let code: ErrorCode = "STREAM_WARMUP_ERROR";
                    let message: string;

                    if (reason === "timeout") {
                        code = "STREAM_WARMUP_TIMEOUT";
                        message = `No tokens received within ${warmupTimeoutMs}ms`;
                    } else if (reason === "empty") {
                        code = "STREAM_WARMUP_EMPTY";
                        message = "Provider closed the stream without emitting any tokens";
                    } else if (!peek.ok && peek.reason === "error" && peek.error instanceof Error) {
                        message = earlyErrorMessage ?? peek.error.message;
                    } else {
                        message = earlyErrorMessage ?? "Provider stream errored before first token";
                    }

                    const { elapsedMs } = peek;

                    const enriched = enrichError(code, message, { modelId: body.modelId, provider: body.provider }, c.env.PUBLIC_DASHBOARD_URL);

                    return c.json(
                        {
                            error: {
                                code,
                                message,
                                ...(enriched.userFacingCode && { userFacingCode: enriched.userFacingCode }),
                                ...(enriched.userFacingMessage !== message && { userFacingMessage: enriched.userFacingMessage }),
                                ...(enriched.actions && enriched.actions.length > 0 && { actions: enriched.actions }),
                                elapsedMs,
                                modelId: body.modelId,
                                provider: body.provider,
                            },
                        },
                        502,
                    );
                }

                firstChunk = peek.first;
                warmupElapsedMs = peek.elapsedMs;
            }

            let ttftMs: number | undefined = firstChunk === undefined ? undefined : warmupElapsedMs;
            // Capture executionCtx so background work survives after response completes
            const execContext = c.executionCtx;

            const stream = new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();

                    try {
                        // Replay the buffered first chunk from the warm-up peek.
                        if (firstChunk !== undefined) {
                            controller.enqueue(encoder.encode(firstChunk));
                        }

                        // Drain the rest of the iterator. After the peek call,
                        // sseIterator is positioned AFTER the first item, so a
                        // plain `for-await` covers the remaining stream.
                        const remainingChunks = { [Symbol.asyncIterator]: () => sseIterator };

                        for await (const chunk of remainingChunks) {
                            if (ttftMs === undefined) {
                                ttftMs = Date.now() - startTime;
                            }

                            controller.enqueue(encoder.encode(chunk));
                        }

                        // Wait for the result to complete and get final usage
                        const finalUsage = await result.usage;
                        const finishReason = await result.finishReason;
                        const latencyMs = Date.now() - startTime;
                        const tokens = extractTokenCounts(finalUsage);

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

                        // Send final finish event with cost data
                        const finishChunk = formatSSE({
                            cost: { microdollars: costMicrodollars, pricingAvailable: pricing !== null },
                            finishReason,
                            type: "finish",
                            usage: {
                                cachedTokens: tokens.cachedTokens,
                                completionTokens: tokens.completionTokens,
                                promptTokens: tokens.promptTokens,
                                reasoningTokens: tokens.reasoningTokens,
                            },
                        });

                        controller.enqueue(encoder.encode(finishChunk));

                        // Record usage via waitUntil so it survives after stream/response ends.
                        // Use allSettled so individual failures don't cause uncaught rejections.
                        execContext.waitUntil(
                            Promise.allSettled([
                                usageTracker.record(
                                    {
                                        cachedTokens: tokens.cachedTokens,
                                        completionTokens: tokens.completionTokens,
                                        costMicrodollars,
                                        finishReason,
                                        guardrailViolations: guardrailViolationsJson,
                                        isStreaming: true,
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
                                        ttftMs,
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
                    } catch (error) {
                        const errorChunk = formatSSE({
                            error: {
                                code: "PROVIDER_ERROR",
                                message: error instanceof Error ? error.message : "Unknown stream error",
                            },
                            type: "error",
                        });

                        controller.enqueue(encoder.encode(errorChunk));

                        // Record failure via waitUntil
                        execContext.waitUntil(healthService.recordFailure(body.provider, body.modelApiId));
                    } finally {
                        controller.close();
                    }
                },
            });

            return new Response(stream, {
                headers: {
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "Content-Type": "text/event-stream",
                    "X-Request-Id": c.get("requestId") ?? "",
                    ...compressionHeaders,
                },
                status: 200,
            });
        } catch (error) {
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
                },
                502,
            );
        }
    },
);

export { streamRouter };
