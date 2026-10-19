/**
 * POST /v1/chat/completions — OpenAI-compatible SaaS API.
 *
 * Supports both streaming and non-streaming modes. Uses Bearer token
 * auth (gk_* keys) validated via bearerAuth middleware.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ModelMessage, ToolChoice, ToolSet } from "ai";
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
import { dailyLimitMiddleware } from "../../middleware/daily-limit.js";
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
    /** Only on the final chunk of a stream that asked for `stream_options.include_usage`. */
    usage?: ChatUsage;
}

interface ChatUsage {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
}

/** A tool call as the AI SDK returns it, before it is written in the chat wire shape. */
interface ToolCallLike {
    input: unknown;
    toolCallId: string;
    toolName: string;
}

const toolCallSchema = z.object({
    function: z.object({ arguments: z.string(), name: z.string() }),
    id: z.string(),
    type: z.literal("function"),
});

const requestSchema = z.object({
    frequency_penalty: z.number().optional(),
    max_tokens: z.number().optional(),
    messages: z.array(
        z.object({
            content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).nullish(),
            name: z.string().optional(),
            role: z.enum(["system", "user", "assistant", "tool"]),
            tool_call_id: z.string().optional(),
            tool_calls: z.array(toolCallSchema).optional(),
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
    /** Only `include_usage` is read: when set, a streamed reply ends with a usage chunk. */
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    temperature: z.number().optional(),
    tool_choice: z
        .union([z.enum(["auto", "none", "required"]), z.object({ function: z.object({ name: z.string() }), type: z.literal("function") })])
        .optional(),
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

type RequestMessage = z.infer<typeof requestSchema>["messages"][number];

/** The text of a message's content: a string as is, a parts array as its text parts joined. */
const plainText = (content: RequestMessage["content"]): string => {
    if (typeof content === "string") {
        return content;
    }

    return (content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("");
};

/**
 * A tool result's text. A parts array (`[{ type: "text", text }]`, which the schema accepts) is its
 * text parts joined, not its JSON, which would cost the model extra tokens and read as noise; an
 * array with no text part at all is passed as JSON so nothing is dropped.
 */
const toolResultText = (content: RequestMessage["content"]): string => {
    if (typeof content === "string") {
        return content;
    }

    if (content == null) {
        return "";
    }

    return content.some((part) => typeof part.text === "string") ? plainText(content) : JSON.stringify(content);
};

/** Clients send tool arguments as a JSON string; the model wants the object. Text that is not JSON is passed as sent. */
const parseArguments = (raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
};

/**
 * Convert OpenAI-format messages to AI SDK ModelMessage format. An assistant's
 * `tool_calls` become tool-call parts, and each tool result takes its tool's name
 * from the call it answers, matched by id: the AI SDK needs both to replay a
 * tool round trip. Ids are reused across turns (`call_0` every time), so the
 * map follows the walk: a result takes the nearest call before it with its id.
 */
export const convertMessages = (messages: RequestMessage[]): ModelMessage[] => {
    const toolNames = new Map<string, string>();

    return messages.map((message): ModelMessage => {
        const calls = message.tool_calls ?? [];

        for (const call of calls) {
            toolNames.set(call.id, call.function.name);
        }

        if (message.role === "tool") {
            const toolCallId = message.tool_call_id ?? "";
            const value = toolResultText(message.content);

            return {
                content: [
                    {
                        output: { type: "text", value },
                        toolCallId,
                        toolName: toolNames.get(toolCallId) ?? message.name ?? "",
                        type: "tool-result",
                    },
                ],
                role: "tool",
            };
        }

        if (message.role === "assistant" && message.tool_calls?.length) {
            const text = plainText(message.content);

            return {
                content: [
                    ...(text === "" ? [] : [{ text, type: "text" as const }]),
                    ...message.tool_calls.map((call) => {
                        return {
                            input: parseArguments(call.function.arguments),
                            toolCallId: call.id,
                            toolName: call.function.name,
                            type: "tool-call" as const,
                        };
                    }),
                ],
                role: "assistant",
            };
        }

        return {
            content: message.content ?? "",
            role: message.role as "system" | "user" | "assistant",
        } as ModelMessage;
    });
};

/** A tool call in the chat wire shape. Arguments are a JSON string, as OpenAI sends them. */
const chatToolCall = (call: ToolCallLike) => {
    return {
        function: { arguments: JSON.stringify(call.input ?? {}), name: call.toolName },
        id: call.toolCallId,
        type: "function" as const,
    };
};

/** A whole tool call as one stream delta. `index` numbers the calls within the stream, so clients can tell two apart. */
const toolCallDelta = (call: ToolCallLike, index: number) => {
    return { ...chatToolCall(call), index };
};

const usageJson = (tokens: { completionTokens: number; promptTokens: number }): ChatUsage => {
    return {
        completion_tokens: tokens.completionTokens,
        prompt_tokens: tokens.promptTokens,
        total_tokens: tokens.promptTokens + tokens.completionTokens,
    };
};

/** The AI SDK's tool choice for the request's `tool_choice`. `undefined` leaves the SDK default, `auto`. */
const toolChoiceOf = (choice: z.infer<typeof requestSchema>["tool_choice"]): ToolChoice<ToolSet> | undefined => {
    if (choice === undefined) {
        return undefined;
    }

    return typeof choice === "string" ? choice : { toolName: choice.function.name, type: "tool" };
};

// Standard Hono route (not openapi) because streaming returns raw Response,
// which is incompatible with OpenAPIHono's typed response system.
// bearerAuth must run before rateLimitMiddleware so that userId/userTier are
// available for the per-user KV counter check.
completionsRouter.use("/v1/chat/completions", bearerAuth);
completionsRouter.use("/v1/chat/completions", rateLimitMiddleware);
// Idempotency runs before the daily cap: a retry of a completed call replays its
// cached reply without a new call, so the cap must not refuse it. A cap 429 is
// transient and never cached, so it cannot poison a later replay.
completionsRouter.use("/v1/chat/completions", idempotencyMiddleware);
completionsRouter.use("/v1/chat/completions", dailyLimitMiddleware);
completionsRouter.post("/v1/chat/completions", async (c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const rawBody = await c.req.json();
    const parsed = requestSchema.safeParse(rawBody);

    if (!parsed.success) {
        return c.json({ error: { ...toSafeValidationPayload(parsed.error.flatten(), { env: c.env, requestId }), type: "invalid_request_error" } }, 400);
    }

    const body = parsed.data;

    // Without tools (none, or an empty array) there is nothing to require or name, and a silent drop would hand back a plain reply the caller asked us not to give.
    if ((body.tools === undefined || body.tools.length === 0) && body.tool_choice !== undefined && body.tool_choice !== "auto" && body.tool_choice !== "none") {
        return c.json({ error: { message: "tool_choice requires a tools array", param: "tool_choice", type: "invalid_request_error" } }, 400);
    }

    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const startTime = Date.now();
    const isUsageRequested = body.stream_options?.include_usage === true;

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

    // Convert OpenAI-format tools to AI SDK tool definitions. The tool choice only means
    // something alongside tools, so both travel in one spread.
    const aiTools = openAIToolsToToolSet(body.tools);
    const toolOptions = aiTools ? { toolChoice: toolChoiceOf(body.tool_choice), tools: aiTools } : {};

    try {
        const model = await createProviderModelForEnv(c.env, provider, modelApiId, apiKey);

        if (body.stream) {
            // ── Streaming mode ──
            const abortController = new AbortController();
            const result = streamText({
                abortSignal: abortController.signal,
                maxOutputTokens: body.max_tokens,
                messages: effectiveMessages as Parameters<typeof streamText>[0]["messages"],
                model,
                temperature: body.temperature,
                topP: body.top_p,
                ...toolOptions,
            } as Parameters<typeof streamText>[0]);

            const execContext = c.executionCtx;
            let isCancelled = false;

            const stream = new ReadableStream({
                cancel(reason) {
                    isCancelled = true;
                    abortController.abort(reason);
                },
                async start(controller) {
                    const encoder = new TextEncoder();
                    const send = (text: string): void => {
                        if (!isCancelled) {
                            controller.enqueue(encoder.encode(text));
                        }
                    };
                    const sendChunk = (data: ChatCompletionChunk) => {
                        send(`data: ${JSON.stringify(data)}\n\n`);
                    };
                    let hasFailed = false;
                    let toolCallCount = 0;

                    try {
                        for await (const part of result.fullStream) {
                            switch (part.type) {
                                case "error": {
                                    hasFailed = true;
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
                                        choices: [{ delta: { tool_calls: [toolCallDelta(part, toolCallCount++)] }, finish_reason: null, index: 0 }],
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
                        const finalUsage = await result.usage;
                        const tokens = extractTokenCounts(finalUsage);

                        sendChunk({
                            choices: [{ delta: {}, finish_reason: mapFinishReason(finishReason), index: 0 }],
                            created,
                            id: completionId,
                            model: modelId,
                            object: "chat.completion.chunk",
                        });

                        if (isUsageRequested) {
                            sendChunk({ choices: [], created, id: completionId, model: modelId, object: "chat.completion.chunk", usage: usageJson(tokens) });
                        }

                        send("data: [DONE]\n\n");

                        // Record usage
                        const latencyMs = Date.now() - startTime;
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
                                        // A provider error inside the stream is a failed call, so its GenAI span must not export as OK.
                                        ...(hasFailed && { errorCode: "PROVIDER_ERROR" }),
                                        finishReason,
                                        guardrailViolations: guardrailViolationsJson,
                                        isStreaming: true,
                                        latencyMs,
                                        modelApiId,
                                        modelId,
                                        operation: "chat",
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
                                ...(isCancelled
                                    ? []
                                    : [
                                          hasFailed
                                              ? healthService.recordFailure(provider, modelApiId)
                                              : healthService.recordSuccess(provider, modelApiId, latencyMs),
                                      ]),
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
                                ...(hasFailed || isCancelled
                                    ? []
                                    : [
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
                            ]),
                        );
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : "Unknown error";
                        // SSE frame to client: sanitized payload with requestId.
                        const safe = toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId });

                        send(`data: ${JSON.stringify({ error: { ...safe, type: "server_error" } })}\n\n`);

                        if (!isCancelled) {
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
                        }
                    } finally {
                        if (!isCancelled) {
                            controller.close();
                        }
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
            topP: body.top_p,
            ...toolOptions,
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
        // A turn that calls tools has no final answer to validate yet; its text is empty by design.
        let isHealed = false;
        const responseFormat = body.response_format;

        if (responseFormat && responseFormat.type !== "text" && result.toolCalls.length === 0) {
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
                        operation: "chat",
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
                        message: {
                            content: responseText === "" ? null : responseText,
                            role: "assistant",
                            ...(result.toolCalls.length > 0 && { tool_calls: result.toolCalls.map((call) => chatToolCall(call)) }),
                        },
                    },
                ],
                created,
                id: completionId,
                model: modelId,
                object: "chat.completion",
                usage: usageJson(tokens),
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

                if (body.stream) {
                    const fbResult = streamText({
                        maxOutputTokens: body.max_tokens,
                        messages: fallbackMessages as Parameters<typeof streamText>[0]["messages"],
                        model: fallbackModel,
                        temperature: body.temperature,
                        topP: body.top_p,
                        ...toolOptions,
                    } as Parameters<typeof streamText>[0]);

                    const execContext = c.executionCtx;
                    const stream = new ReadableStream({
                        async start(controller) {
                            const encoder = new TextEncoder();
                            const sendChunk = (data: ChatCompletionChunk) => {
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                            };
                            let toolCallCount = 0;
                            let hasFailed = false;

                            try {
                                for await (const part of fbResult.fullStream) {
                                    switch (part.type) {
                                        case "error": {
                                            hasFailed = true;
                                            sendChunk({
                                                choices: [{ delta: {}, finish_reason: "error", index: 0 }],
                                                created: fallbackCreated,
                                                id: fallbackCompletionId,
                                                model: fallbackCandidate.modelId,
                                                object: "chat.completion.chunk",
                                            });
                                            break;
                                        }
                                        case "text-delta": {
                                            sendChunk({
                                                choices: [{ delta: { content: part.text }, finish_reason: null, index: 0 }],
                                                created: fallbackCreated,
                                                id: fallbackCompletionId,
                                                model: fallbackCandidate.modelId,
                                                object: "chat.completion.chunk",
                                            });
                                            break;
                                        }
                                        case "tool-call": {
                                            sendChunk({
                                                choices: [{ delta: { tool_calls: [toolCallDelta(part, toolCallCount++)] }, finish_reason: null, index: 0 }],
                                                created: fallbackCreated,
                                                id: fallbackCompletionId,
                                                model: fallbackCandidate.modelId,
                                                object: "chat.completion.chunk",
                                            });
                                            break;
                                        }
                                        default: {
                                            break;
                                        }
                                    }
                                }

                                const finishReason = await fbResult.finishReason;
                                const finalUsage = await fbResult.usage;
                                const tokens = extractTokenCounts(finalUsage);

                                sendChunk({
                                    choices: [{ delta: {}, finish_reason: mapFinishReason(finishReason), index: 0 }],
                                    created: fallbackCreated,
                                    id: fallbackCompletionId,
                                    model: fallbackCandidate.modelId,
                                    object: "chat.completion.chunk",
                                });

                                if (isUsageRequested) {
                                    sendChunk({
                                        choices: [],
                                        created: fallbackCreated,
                                        id: fallbackCompletionId,
                                        model: fallbackCandidate.modelId,
                                        object: "chat.completion.chunk",
                                        usage: usageJson(tokens),
                                    });
                                }

                                controller.enqueue(encoder.encode("data: [DONE]\n\n"));

                                const latencyMs = Date.now() - startTime;
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
                                                // A provider error inside the stream is a failed call, so its GenAI span must not export as OK.
                                                ...(hasFailed && { errorCode: "PROVIDER_ERROR" }),
                                                finishReason,
                                                guardrailViolations: guardrailViolationsJson,
                                                isStreaming: true,
                                                latencyMs,
                                                modelApiId: fallbackCandidate.modelApiId,
                                                modelId: fallbackCandidate.modelId,
                                                operation: "chat",
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
                                        // A provider error inside the stream is a failed call: the circuit breaker must see it as one.
                                        hasFailed
                                            ? healthService.recordFailure(fallbackCandidate.provider, fallbackCandidate.modelApiId)
                                            : healthService.recordSuccess(fallbackCandidate.provider, fallbackCandidate.modelApiId, latencyMs),
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
                    topP: body.top_p,
                    ...toolOptions,
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
                                operation: "chat",
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
                        choices: [
                            {
                                finish_reason: mapFinishReason(fbResult.finishReason),
                                index: 0,
                                message: {
                                    content: responseText === "" ? null : responseText,
                                    role: "assistant",
                                    ...(fbResult.toolCalls.length > 0 && { tool_calls: fbResult.toolCalls.map((call) => chatToolCall(call)) }),
                                },
                            },
                        ],
                        created: fallbackCreated,
                        id: fallbackCompletionId,
                        model: fallbackCandidate.modelId,
                        object: "chat.completion",
                        usage: usageJson(tokens),
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
