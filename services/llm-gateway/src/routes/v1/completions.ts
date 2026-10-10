/**
 * POST /v1/chat/completions — OpenAI-compatible SaaS API.
 *
 * Supports both streaming and non-streaming modes. Uses Bearer token
 * auth (gk_* keys) validated via bearerAuth middleware.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import { generateText, streamText } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { contextPreflight } from "../../lib/context-preflight.js";
import { GatewayError, toSafeErrorPayload, toSafeValidationPayload } from "../../lib/errors.js";
import { DEFAULT_GUARDRAIL_CONFIG, scanInput, scanOutput } from "../../lib/guardrails.js";
import type { JSONSchema } from "../../lib/structured-output.js";
import { healJsonResponse, repairWithModel, validateJsonResponse } from "../../lib/structured-output.js";
import { extractTokenCounts } from "../../lib/token-counter.js";
import { estimateMessageTokens } from "../../lib/token-estimator.js";
import { openAIToolsToToolSet } from "../../lib/tool-set.js";
import { buildEvent, deliverEvent } from "../../lib/webhook-delivery.js";
import { bearerAuth } from "../../middleware/auth.js";
import { idempotencyMiddleware } from "../../middleware/idempotency.js";
import { rateLimitMiddleware } from "../../middleware/rate-limit.js";
import { GATEWAY_MODELS, MODEL_MAP } from "../../models.js";
import { createProviderModelForEnv, resolveApiKey } from "../../providers/factory.js";
import { ProviderHealthService } from "../../providers/health.js";
import { isMockLlmEnabled, MOCK_PROVIDER } from "../../providers/mock-model.js";
import { calculateCost, PricingService } from "../../providers/pricing.js";
import { classifyFailure, extractProviderErrorInfo, selectFallback } from "../../routing/fallback.js";
import { scoreQuery } from "../../routing/scorer.js";
import { selectModel } from "../../routing/selector.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

const completionsRouter = new OpenAPIHono<HonoEnv>();

/** An OpenAI tool converted to the AI SDK's shape. `parameters` is an unvalidated JSON Schema blob. */
interface AiToolDefinition {
    description: string;
    parameters: unknown;
}

/** One `chat.completion.chunk` SSE frame, as the OpenAI streaming API defines it. */
interface ChatCompletionChunk {
    choices: {
        delta: {
            content?: string;
            tool_calls?: { function: { arguments: string; name: string }; id: string; index: number; type: string }[];
        };
        finish_reason: string | null;
        index: number;
    }[];
    created: number;
    id: string;
    model: string;
    object: string;
}

const requestSchema = z.object({
    frequency_penalty: z.number().optional(),
    max_tokens: z.number().optional(),
    messages: z.array(
        z.object({
            content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
            name: z.string().optional(),
            role: z.enum(["system", "user", "assistant", "tool"]),
            tool_call_id: z.string().optional(),
            tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
        }),
    ),
    model: z.string(),
    presence_penalty: z.number().optional(),
    /** Structured output format. json_object or json_schema trigger validation + healing. */
    response_format: z
        .union([
            z.object({ type: z.literal("json_object") }),
            z.object({ json_schema: z.record(z.string(), z.unknown()), type: z.literal("json_schema") }),
            z.object({ type: z.literal("text") }),
        ])
        .optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    tools: z
        .array(
            z.object({
                function: z.object({
                    description: z.string().optional(),
                    name: z.string(),
                    parameters: z.record(z.string(), z.unknown()).optional(),
                }),
                type: z.literal("function"),
            }),
        )
        .optional(),
    top_p: z.number().optional(),
    /** Optional transforms (OpenRouter-compatible). Supported: `"middle-out"`. */
    transforms: z.array(z.string()).optional(),
});

/**
 * Convert OpenAI-format messages to AI SDK ModelMessage format.
 */
const convertMessages = (messages: z.infer<typeof requestSchema>["messages"]): ModelMessage[] =>
    messages.map((message) => {
        if (message.role === "tool") {
            // AI SDK v6 ToolResultPart has complex output typing — cast through unknown
            return {
                content: [
                    {
                        output: [{ text: typeof message.content === "string" ? message.content : JSON.stringify(message.content), type: "text" }],
                        toolCallId: message.tool_call_id ?? "",
                        toolName: "",
                        type: "tool-result",
                    },
                ],
                role: "tool",
            } as unknown as ModelMessage;
        }

        return {
            content: typeof message.content === "string" ? message.content : (message.content as ModelMessage["content"]),
            role: message.role as "system" | "user" | "assistant",
        } as ModelMessage;
    });

// Standard Hono route (not openapi) because streaming returns raw Response,
// which is incompatible with OpenAPIHono's typed response system.
// bearerAuth must run before rateLimitMiddleware so that userId/userTier are
// available for the per-user KV counter check.
completionsRouter.use("/v1/chat/completions", bearerAuth);
completionsRouter.use("/v1/chat/completions", rateLimitMiddleware);
// Idempotency must run after auth (needs userId) and before the route handler
completionsRouter.use("/v1/chat/completions", idempotencyMiddleware);
completionsRouter.post("/v1/chat/completions", async (c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const rawBody = await c.req.json();
    const parsed = requestSchema.safeParse(rawBody);

    if (!parsed.success) {
        return c.json({ error: { ...toSafeValidationPayload(parsed.error.flatten(), { env: c.env, requestId }), type: "invalid_request_error" } }, 400);
    }

    const body = parsed.data;
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const startTime = Date.now();

    const healthService = new ProviderHealthService(c.env);
    const pricingService = new PricingService(c.env);
    const usageTracker = new UsageTracker(c.env);
    const usageReporter = new UsageReporter(c.env);

    // Resolve model — "auto" triggers smart routing
    let provider: string;
    let modelApiId: string;
    let modelId: string;

    if (body.model === "auto") {
        const messages = convertMessages(body.messages);
        const score = scoreQuery({
            messages,
            // Distinct tool names, matching the keyed map this used to build —
            // two entries sharing a name counted once.
            toolCount: body.tools ? new Set(body.tools.map((t) => t.function.name)).size : 0,
            userTier: c.get("userTier") ?? "free",
        });

        const route = await selectModel(score, GATEWAY_MODELS, healthService, undefined, pricingService);

        provider = route.provider;
        modelApiId = route.modelApiId;
        modelId = route.modelId;
    } else if (isMockLlmEnabled(c.env) && body.model.startsWith(`${MOCK_PROVIDER}/`)) {
        // `mock/echo` is in no catalogue; it exists only while MOCK_LLM is on.
        provider = MOCK_PROVIDER;
        modelApiId = body.model.slice(MOCK_PROVIDER.length + 1);
        modelId = body.model;
    } else {
        const candidate = MODEL_MAP.get(body.model);

        if (!candidate) {
            return c.json(
                { error: { message: `Model '${body.model}' not found. Use GET /v1/models to see available models.`, type: "invalid_request_error" } },
                400,
            );
        }

        provider = candidate.provider;
        modelApiId = candidate.modelApiId;
        modelId = candidate.modelId;
    }

    // Resolve API key
    let apiKey: string;

    try {
        apiKey = resolveApiKey(provider, c.env);
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { message: error.message, type: "server_error" } }, 502);
        }

        return c.json({ error: { message: "Failed to resolve provider API key", type: "server_error" } }, 500);
    }

    let aiMessages = convertMessages(body.messages);

    // Context window pre-flight check
    let candidateContextWindow = MODEL_MAP.get(modelId)?.contextWindow;
    const preflight = contextPreflight(aiMessages as { content: unknown; role: string }[], candidateContextWindow, undefined, body.transforms);

    const compressionHeaders: Record<string, string> = {};

    if (preflight.status === "overflow") {
        // Pre-flight context overflow: try to route to a larger-context model before returning error
        const preflightFallback = await selectFallback("context_overflow", modelId, candidateContextWindow, GATEWAY_MODELS, healthService);

        if (preflightFallback) {
            // Silently upgrade to the larger-context model
            provider = preflightFallback.provider;
            modelApiId = preflightFallback.modelApiId;
            modelId = preflightFallback.modelId;
            candidateContextWindow = preflightFallback.contextWindow;
            compressionHeaders["X-Gateway-Fallback-Model"] = preflightFallback.modelId;
            compressionHeaders["X-Gateway-Fallback-Reason"] = "context_overflow";
        } else {
            return c.json(
                {
                    error: {
                        code: "context_limit_exceeded",
                        contextWindow: preflight.contextWindow,
                        estimatedTokens: preflight.estimatedTokens,
                        message: `Estimated prompt tokens (${preflight.estimatedTokens}) exceed model context window (${preflight.contextWindow}). Use 'transforms: ["middle-out"]' to enable automatic compression.`,
                        type: "invalid_request_error",
                    },
                },
                413,
            );
        }
    } else if (preflight.status === "compressed") {
        aiMessages = preflight.messages as typeof aiMessages;
        compressionHeaders["X-Gateway-Compressed"] = "true";
        compressionHeaders["X-Gateway-Compressed-Tokens-Before"] = String(preflight.originalTokens);
        compressionHeaders["X-Gateway-Compressed-Tokens-After"] = String(preflight.compressedTokens);
    }

    // Capture estimated prompt tokens for fallback classification (after possible compression)
    const estimatedPromptTokens = estimateMessageTokens(aiMessages as { content: unknown; role: string }[]);

    // ── Guardrail scan (SaaS Bearer auth: always enforce defaults, no bypass) ──
    const guardrailResult = scanInput(aiMessages as Parameters<typeof scanInput>[0], DEFAULT_GUARDRAIL_CONFIG);

    if (!guardrailResult.passed) {
        const isInjection = guardrailResult.violations.some((v) => v.type === "injection");

        // Fire guardrail webhook (non-blocking, best-effort)
        c.executionCtx.waitUntil(
            deliverEvent(
                c.env.USAGE_DB,
                buildEvent(
                    "guardrail_triggered",
                    userId,
                    {
                        isInjection,
                        requestId,
                        violations: guardrailResult.violations,
                    },
                    orgId,
                ),
            ),
        );

        return c.json(
            {
                error: {
                    code: isInjection ? "prompt_injection_detected" : "pii_detected",
                    message: isInjection ? "Request blocked: prompt injection detected." : "Request blocked: PII detected in messages.",
                    type: "invalid_request_error",
                    violations: guardrailResult.violations,
                },
            },
            400,
        );
    }

    // Use masked messages if PII was redacted
    const effectiveMessages = guardrailResult.maskedMessages ?? aiMessages;
    const guardrailViolationsJson = guardrailResult.violations.length > 0 ? JSON.stringify(guardrailResult.violations) : undefined;

    const completionId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 29)}`;
    const created = Math.floor(Date.now() / 1000);

    // Convert OpenAI-format tools to AI SDK tool definitions
    const aiTools = openAIToolsToToolSet(body.tools);

    try {
        const model = await createProviderModelForEnv(c.env, provider, modelApiId, apiKey);

        if (body.stream) {
            // ── Streaming mode ──
            const result = streamText({
                maxOutputTokens: body.max_tokens,
                messages: effectiveMessages as Parameters<typeof streamText>[0]["messages"],
                model,
                temperature: body.temperature,
                ...(aiTools && { tools: aiTools }),
            } as Parameters<typeof streamText>[0]);

            const execContext = c.executionCtx;

            const stream = new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    const sendChunk = (data: ChatCompletionChunk) => {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    };

                    try {
                        for await (const part of result.fullStream) {
                            switch (part.type) {
                                case "error": {
                                    sendChunk({
                                        choices: [{ delta: {}, finish_reason: "error", index: 0 }],
                                        created,
                                        id: completionId,
                                        model: modelId,
                                        object: "chat.completion.chunk",
                                    });
                                    break;
                                }

                                case "text-delta": {
                                    sendChunk({
                                        choices: [{ delta: { content: part.text }, finish_reason: null, index: 0 }],
                                        created,
                                        id: completionId,
                                        model: modelId,
                                        object: "chat.completion.chunk",
                                    });
                                    break;
                                }

                                case "tool-call": {
                                    sendChunk({
                                        choices: [
                                            {
                                                delta: {
                                                    tool_calls: [
                                                        {
                                                            function: {
                                                                arguments: JSON.stringify(part.input ?? {}),
                                                                name: part.toolName,
                                                            },
                                                            id: part.toolCallId,
                                                            index: 0,
                                                            type: "function",
                                                        },
                                                    ],
                                                },
                                                finish_reason: null,
                                                index: 0,
                                            },
                                        ],
                                        created,
                                        id: completionId,
                                        model: modelId,
                                        object: "chat.completion.chunk",
                                    });
                                    break;
                                }
                                default: {
                                    // Other stream parts carry no OpenAI-compatible delta.
                                    break;
                                }
                            }
                        }

                        // Final chunk with finish_reason
                        const finishReason = await result.finishReason;

                        sendChunk({
                            choices: [{ delta: {}, finish_reason: mapFinishReason(finishReason), index: 0 }],
                            created,
                            id: completionId,
                            model: modelId,
                            object: "chat.completion.chunk",
                        });

                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

                        // Record usage
                        const finalUsage = await result.usage;
                        const latencyMs = Date.now() - startTime;
                        const tokens = extractTokenCounts(finalUsage);
                        const pricing = await pricingService.getPricing(modelApiId);
                        const costMicrodollars = pricing
                            ? calculateCost(pricing, {
                                  cachedTokens: tokens.cachedTokens,
                                  completionTokens: tokens.completionTokens,
                                  promptTokens: tokens.promptTokens,
                                  reasoningTokens: tokens.reasoningTokens,
                              })
                            : 0;

                        execContext.waitUntil(
                            Promise.allSettled([
                                usageTracker.recordAndEvaluate(
                                    {
                                        apiKeyId,
                                        cachedTokens: tokens.cachedTokens,
                                        completionTokens: tokens.completionTokens,
                                        costMicrodollars,
                                        finishReason,
                                        guardrailViolations: guardrailViolationsJson,
                                        isStreaming: true,
                                        latencyMs,
                                        modelApiId,
                                        modelId,
                                        orgId,
                                        promptTokens: tokens.promptTokens,
                                        provider,
                                        reasoningTokens: tokens.reasoningTokens,
                                        requestId,
                                        source: "saas_api",
                                        userId,
                                    },
                                    c.var.telemetry,
                                ),
                                healthService.recordSuccess(provider, modelApiId, latencyMs),
                                usageReporter.report({
                                    // Platform env keys only on this route — never BYOK.
                                    billingMode: "platform",
                                    completionTokens: tokens.completionTokens,
                                    costMicrodollars,
                                    modelId,
                                    orgId,
                                    promptTokens: tokens.promptTokens,
                                    requestId,
                                    userId,
                                }),
                                // Fire completion webhook (non-blocking)
                                deliverEvent(
                                    c.env.USAGE_DB,
                                    buildEvent(
                                        "completion",
                                        userId,
                                        {
                                            completionTokens: tokens.completionTokens,
                                            costMicrodollars,
                                            finishReason,
                                            latencyMs,
                                            modelId,
                                            promptTokens: tokens.promptTokens,
                                            requestId,
                                        },
                                        orgId,
                                    ),
                                ),
                            ]),
                        );
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : "Unknown error";
                        // SSE frame to client: sanitized payload with requestId.
                        const safe = toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId });

                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { ...safe, type: "server_error" } })}\n\n`));
                        execContext.waitUntil(
                            Promise.allSettled([
                                healthService.recordFailure(provider, modelApiId),
                                deliverEvent(
                                    c.env.USAGE_DB,
                                    buildEvent(
                                        "provider_error",
                                        userId,
                                        {
                                            errorMessage,
                                            latencyMs: Date.now() - startTime,
                                            modelId,
                                            requestId,
                                        },
                                        orgId,
                                    ),
                                ),
                            ]),
                        );
                    } finally {
                        controller.close();
                    }
                },
            });

            const origin = c.req.header("Origin");
            const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? [];
            const corsHeaders: Record<string, string> = {};

            if (origin && allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
                corsHeaders["Access-Control-Allow-Origin"] = origin;
                corsHeaders["Vary"] = "Origin";
            }

            return new Response(stream, {
                headers: {
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "Content-Type": "text/event-stream",
                    "X-Request-Id": requestId,
                    ...corsHeaders,
                    ...compressionHeaders,
                },
                status: 200,
            });
        }

        // ── Non-streaming mode ──
        const result = await generateText({
            maxOutputTokens: body.max_tokens,
            messages: effectiveMessages as Parameters<typeof generateText>[0]["messages"],
            model,
            temperature: body.temperature,
            ...(aiTools && { tools: aiTools }),
        } as Parameters<typeof generateText>[0]);

        const latencyMs = Date.now() - startTime;
        const tokens = extractTokenCounts(result.usage);
        const pricing = await pricingService.getPricing(modelApiId);
        const costMicrodollars = pricing
            ? calculateCost(pricing, {
                  cachedTokens: tokens.cachedTokens,
                  completionTokens: tokens.completionTokens,
                  promptTokens: tokens.promptTokens,
                  reasoningTokens: tokens.reasoningTokens,
              })
            : 0;

        // Scan output for PII before returning to client
        const outputScan = scanOutput(result.text, DEFAULT_GUARDRAIL_CONFIG);
        let responseText = outputScan.action === "mask" && outputScan.maskedContent !== undefined ? outputScan.maskedContent : result.text;
        const allViolationsJson = guardrailViolationsJson ?? (outputScan.violations.length > 0 ? JSON.stringify(outputScan.violations) : undefined);

        // ── Structured output validation and healing ──
        let isHealed = false;
        const responseFormat = body.response_format;

        if (responseFormat && responseFormat.type !== "text") {
            const schema = responseFormat.type === "json_schema" ? (responseFormat.json_schema as JSONSchema) : undefined;
            const schemaDesc = schema ? JSON.stringify(schema).slice(0, 500) : "JSON object";

            const validation = validateJsonResponse(responseText, schema);

            if (!validation.valid) {
                // Tier 1: heuristic heal
                const healed1 = healJsonResponse(responseText);

                if (healed1 !== null && validateJsonResponse(healed1, schema).valid) {
                    responseText = healed1;
                    isHealed = true;
                } else {
                    // Tier 2: model-based repair (single pass, max 1 attempt)
                    const healed2 = await repairWithModel(model, responseText, schemaDesc);

                    if (healed2 !== null && validateJsonResponse(healed2, schema).valid) {
                        responseText = healed2;
                        isHealed = true;
                    } else {
                        // Cannot heal — return 422
                        return c.json(
                            {
                                error: {
                                    code: "structured_output_failed",
                                    message: "Structured output validation failed and could not be repaired.",
                                    rawResponse: responseText,
                                    type: "invalid_response_error",
                                },
                            },
                            422,
                        );
                    }
                }
            }
        }

        // Record usage
        c.executionCtx.waitUntil(
            Promise.allSettled([
                usageTracker.recordAndEvaluate(
                    {
                        apiKeyId,
                        cachedTokens: tokens.cachedTokens,
                        completionTokens: tokens.completionTokens,
                        costMicrodollars,
                        finishReason: result.finishReason,
                        guardrailViolations: allViolationsJson,
                        healed: isHealed,
                        isStreaming: false,
                        latencyMs,
                        modelApiId,
                        modelId,
                        orgId,
                        promptTokens: tokens.promptTokens,
                        provider,
                        reasoningTokens: tokens.reasoningTokens,
                        requestId,
                        source: "saas_api",
                        userId,
                    },
                    c.var.telemetry,
                ),
                healthService.recordSuccess(provider, modelApiId, latencyMs),
                usageReporter.report({
                    // Platform env keys only on this route — never BYOK.
                    billingMode: "platform",
                    completionTokens: tokens.completionTokens,
                    costMicrodollars,
                    modelId,
                    orgId,
                    promptTokens: tokens.promptTokens,
                    requestId,
                    userId,
                }),
                // Fire completion webhook (non-blocking)
                deliverEvent(
                    c.env.USAGE_DB,
                    buildEvent(
                        "completion",
                        userId,
                        {
                            completionTokens: tokens.completionTokens,
                            costMicrodollars,
                            finishReason: result.finishReason,
                            latencyMs,
                            modelId,
                            promptTokens: tokens.promptTokens,
                            requestId,
                        },
                        orgId,
                    ),
                ),
            ]),
        );

        const jsonResp = c.json(
            {
                choices: [
                    {
                        finish_reason: mapFinishReason(result.finishReason),
                        index: 0,
                        message: { content: responseText, role: "assistant" },
                    },
                ],
                created,
                id: completionId,
                model: modelId,
                object: "chat.completion",
                usage: {
                    completion_tokens: tokens.completionTokens,
                    prompt_tokens: tokens.promptTokens,
                    total_tokens: tokens.promptTokens + tokens.completionTokens,
                },
            },
            200,
        );

        for (const [key, value] of Object.entries(compressionHeaders)) {
            jsonResp.headers.set(key, value);
        }

        if (isHealed) jsonResp.headers.set("X-Gateway-Healed", "true");

        return jsonResp;
    } catch (error) {
        c.executionCtx.waitUntil(healthService.recordFailure(provider, modelApiId));

        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        // ── Typed fallback: classify failure and attempt retry with appropriate model ──
        const { body: errorBody, statusCode: errorStatus } = extractProviderErrorInfo(error);
        const fallbackReason = classifyFailure(errorStatus, errorBody, estimatedPromptTokens, candidateContextWindow);
        const fallbackCandidate = await selectFallback(fallbackReason, modelId, candidateContextWindow, GATEWAY_MODELS, healthService);

        if (fallbackCandidate) {
            try {
                const fallbackApiKey = resolveApiKey(fallbackCandidate.provider, c.env);
                const fallbackModel = await createProviderModelForEnv(c.env, fallbackCandidate.provider, fallbackCandidate.modelApiId, fallbackApiKey);
                const fallbackMessages = guardrailResult.maskedMessages ?? aiMessages;

                const fallbackCompletionId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 29)}`;
                const fallbackCreated = Math.floor(Date.now() / 1000);
                const fallbackTools: Record<string, AiToolDefinition> | undefined = body.tools
                    ? Object.fromEntries(
                          body.tools.map((t) => [t.function.name, { description: t.function.description ?? "", parameters: t.function.parameters ?? {} }]),
                      )
                    : undefined;

                if (body.stream) {
                    const fbResult = streamText({
                        maxOutputTokens: body.max_tokens,
                        messages: fallbackMessages as Parameters<typeof streamText>[0]["messages"],
                        model: fallbackModel,
                        temperature: body.temperature,
                        ...(fallbackTools && { tools: fallbackTools }),
                    } as Parameters<typeof streamText>[0]);

                    const execContext = c.executionCtx;
                    const stream = new ReadableStream({
                        async start(controller) {
                            const encoder = new TextEncoder();
                            const sendChunk = (data: ChatCompletionChunk) => {
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                            };

                            try {
                                for await (const part of fbResult.fullStream) {
                                    if (part.type === "text-delta") {
                                        sendChunk({
                                            choices: [{ delta: { content: part.text }, finish_reason: null, index: 0 }],
                                            created: fallbackCreated,
                                            id: fallbackCompletionId,
                                            model: fallbackCandidate.modelId,
                                            object: "chat.completion.chunk",
                                        });
                                    }
                                }

                                const finishReason = await fbResult.finishReason;

                                sendChunk({
                                    choices: [{ delta: {}, finish_reason: mapFinishReason(finishReason), index: 0 }],
                                    created: fallbackCreated,
                                    id: fallbackCompletionId,
                                    model: fallbackCandidate.modelId,
                                    object: "chat.completion.chunk",
                                });
                                controller.enqueue(encoder.encode("data: [DONE]\n\n"));

                                const finalUsage = await fbResult.usage;
                                const latencyMs = Date.now() - startTime;
                                const tokens = extractTokenCounts(finalUsage);
                                const pricing = await pricingService.getPricing(fallbackCandidate.modelApiId);
                                const costMicrodollars = pricing
                                    ? calculateCost(pricing, {
                                          cachedTokens: tokens.cachedTokens,
                                          completionTokens: tokens.completionTokens,
                                          promptTokens: tokens.promptTokens,
                                          reasoningTokens: tokens.reasoningTokens,
                                      })
                                    : 0;

                                execContext.waitUntil(
                                    Promise.allSettled([
                                        usageTracker.recordAndEvaluate(
                                            {
                                                apiKeyId,
                                                cachedTokens: tokens.cachedTokens,
                                                completionTokens: tokens.completionTokens,
                                                costMicrodollars,
                                                fallbackReason,
                                                finishReason,
                                                guardrailViolations: guardrailViolationsJson,
                                                isStreaming: true,
                                                latencyMs,
                                                modelApiId: fallbackCandidate.modelApiId,
                                                modelId: fallbackCandidate.modelId,
                                                orgId,
                                                promptTokens: tokens.promptTokens,
                                                provider: fallbackCandidate.provider,
                                                reasoningTokens: tokens.reasoningTokens,
                                                requestId,
                                                source: "saas_api",
                                                userId,
                                            },
                                            c.var.telemetry,
                                        ),
                                        healthService.recordSuccess(fallbackCandidate.provider, fallbackCandidate.modelApiId, latencyMs),
                                    ]),
                                );
                            } catch {
                                controller.enqueue(
                                    encoder.encode(`data: ${JSON.stringify({ error: { message: "Fallback provider error", type: "server_error" } })}\n\n`),
                                );
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
                            "X-Gateway-Fallback-Model": fallbackCandidate.modelId,
                            "X-Gateway-Fallback-Reason": fallbackReason,
                            "X-Request-Id": requestId,
                            ...compressionHeaders,
                        },
                        status: 200,
                    });
                }

                // Non-streaming fallback
                const fbResult = await generateText({
                    maxOutputTokens: body.max_tokens,
                    messages: fallbackMessages as Parameters<typeof generateText>[0]["messages"],
                    model: fallbackModel,
                    temperature: body.temperature,
                    ...(fallbackTools && { tools: fallbackTools }),
                } as Parameters<typeof generateText>[0]);

                const latencyMs = Date.now() - startTime;
                const tokens = extractTokenCounts(fbResult.usage);
                const pricing = await pricingService.getPricing(fallbackCandidate.modelApiId);
                const costMicrodollars = pricing
                    ? calculateCost(pricing, {
                          cachedTokens: tokens.cachedTokens,
                          completionTokens: tokens.completionTokens,
                          promptTokens: tokens.promptTokens,
                          reasoningTokens: tokens.reasoningTokens,
                      })
                    : 0;

                const outputScan = scanOutput(fbResult.text, DEFAULT_GUARDRAIL_CONFIG);
                const responseText = outputScan.action === "mask" && outputScan.maskedContent !== undefined ? outputScan.maskedContent : fbResult.text;
                const allViolationsJson = guardrailViolationsJson ?? (outputScan.violations.length > 0 ? JSON.stringify(outputScan.violations) : undefined);

                c.executionCtx.waitUntil(
                    Promise.allSettled([
                        usageTracker.recordAndEvaluate(
                            {
                                apiKeyId,
                                cachedTokens: tokens.cachedTokens,
                                completionTokens: tokens.completionTokens,
                                costMicrodollars,
                                fallbackReason,
                                finishReason: fbResult.finishReason,
                                guardrailViolations: allViolationsJson,
                                isStreaming: false,
                                latencyMs,
                                modelApiId: fallbackCandidate.modelApiId,
                                modelId: fallbackCandidate.modelId,
                                orgId,
                                promptTokens: tokens.promptTokens,
                                provider: fallbackCandidate.provider,
                                reasoningTokens: tokens.reasoningTokens,
                                requestId,
                                source: "saas_api",
                                userId,
                            },
                            c.var.telemetry,
                        ),
                        healthService.recordSuccess(fallbackCandidate.provider, fallbackCandidate.modelApiId, latencyMs),
                    ]),
                );

                const jsonResp = c.json(
                    {
                        choices: [{ finish_reason: mapFinishReason(fbResult.finishReason), index: 0, message: { content: responseText, role: "assistant" } }],
                        created: fallbackCreated,
                        id: fallbackCompletionId,
                        model: fallbackCandidate.modelId,
                        object: "chat.completion",
                        usage: {
                            completion_tokens: tokens.completionTokens,
                            prompt_tokens: tokens.promptTokens,
                            total_tokens: tokens.promptTokens + tokens.completionTokens,
                        },
                    },
                    200,
                );

                jsonResp.headers.set("X-Gateway-Fallback-Model", fallbackCandidate.modelId);
                jsonResp.headers.set("X-Gateway-Fallback-Reason", fallbackReason);

                for (const [key, value] of Object.entries(compressionHeaders)) jsonResp.headers.set(key, value);

                return jsonResp;
            } catch {
                // Fallback also failed — fall through to generic error
                c.executionCtx.waitUntil(healthService.recordFailure(fallbackCandidate.provider, fallbackCandidate.modelApiId));
            }
        }

        // All retries exhausted — fire provider_error webhook and return 502.
        // Webhook receives the full error message for support; client gets
        // a sanitized payload.
        const errorMessage = error instanceof Error ? error.message : "Unknown provider error";

        c.executionCtx.waitUntil(
            deliverEvent(
                c.env.USAGE_DB,
                buildEvent(
                    "provider_error",
                    userId,
                    {
                        errorMessage,
                        latencyMs: Date.now() - startTime,
                        modelId,
                        requestId,
                    },
                    orgId,
                ),
            ),
        );

        return c.json({ error: { ...toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId }), type: "server_error" } }, 502);
    }
});

/** Map AI SDK finish reasons to OpenAI-compatible finish_reason values. */
const mapFinishReason = (reason: string): string => {
    switch (reason) {
        case "content-filter": {
            return "content_filter";
        }
        case "end-turn":
        case "stop": {
            return "stop";
        }
        case "length":
        case "max-tokens": {
            return "length";
        }
        case "tool-calls": {
            return "tool_calls";
        }
        default: {
            return "stop";
        }
    }
};

export { completionsRouter };
