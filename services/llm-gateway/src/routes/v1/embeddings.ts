/**
 * POST /v1/embeddings — OpenAI-compatible embeddings endpoint.
 * GET  /v1/embeddings/models — list available embedding models.
 *
 * Centralizes vector generation through the gateway with usage tracking,
 * BYOK support, and rate limiting.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { embed, embedMany } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError, toSafeErrorPayload, toSafeValidationPayload } from "../../lib/errors.js";
import { bearerAuth, internalAuth } from "../../middleware/auth.js";
import { expensiveEndpointRateLimit } from "../../middleware/rate-limit.js";
import { createEmbeddingModel, EMBEDDING_MODELS } from "../../providers/embedding-factory.js";
import { resolveApiKey } from "../../providers/factory.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

const embeddingsRouter = new OpenAPIHono<HonoEnv>();

// Cap input batch size + per-string length so a single request can't enqueue
// arbitrarily expensive embedding work.
const MAX_EMBEDDING_BATCH = 100;
const MAX_EMBEDDING_INPUT_CHARS = 32_000;

const requestSchema = z.object({
    dimensions: z.int().positive().optional(),
    encoding_format: z.enum(["float", "base64"]).optional().default("float"),
    input: z.union([z.string().max(MAX_EMBEDDING_INPUT_CHARS), z.array(z.string().max(MAX_EMBEDDING_INPUT_CHARS)).min(1).max(MAX_EMBEDDING_BATCH)]),
    model: z.string(),
    user: z.string().optional(),
});

embeddingsRouter.use("/v1/embeddings", bearerAuth);
embeddingsRouter.use("/v1/embeddings", expensiveEndpointRateLimit({ bucket: "embeddings" }));
embeddingsRouter.post("/v1/embeddings", async (c) => {
    const rawBody = await c.req.json();
    const parsed = requestSchema.safeParse(rawBody);

    const requestId = c.get("requestId") ?? crypto.randomUUID();

    if (!parsed.success) {
        return c.json({ error: { ...toSafeValidationPayload(parsed.error.flatten(), { env: c.env, requestId }), type: "invalid_request_error" } }, 400);
    }

    const body = parsed.data;
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const startTime = Date.now();

    const modelInfo = EMBEDDING_MODELS[body.model];

    if (!modelInfo) {
        return c.json(
            {
                error: {
                    message: `Embedding model '${body.model}' not found. Use GET /v1/embeddings/models to see available models.`,
                    type: "invalid_request_error",
                },
            },
            400,
        );
    }

    // Resolve API key (BYOK > platform env)
    let apiKey: string;

    try {
        apiKey = resolveApiKey(modelInfo.provider, c.env);
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        return c.json({ error: { ...toSafeErrorPayload(error, { code: "PROVIDER_KEY_ERROR", env: c.env, requestId }), type: "server_error" } }, 500);
    }

    try {
        const model = await createEmbeddingModel(modelInfo.provider, modelInfo.modelApiId, apiKey);
        const inputs = typeof body.input === "string" ? [body.input] : body.input;

        let embeddings: number[][];
        let totalTokens: number;

        if (inputs.length === 1) {
            const result = await embed({ model, value: inputs[0]! });

            embeddings = [result.embedding];
            totalTokens = result.usage?.tokens ?? estimateTokens(inputs[0]!);
        } else {
            const result = await embedMany({ model, values: inputs });

            embeddings = result.embeddings;
            totalTokens = result.usage?.tokens ?? inputs.reduce((accumulator, t) => accumulator + estimateTokens(t), 0);
        }

        const latencyMs = Date.now() - startTime;
        const costMicrodollars = Math.round((totalTokens / 1_000_000) * modelInfo.costPer1MTokensMicrodollars);

        // Track usage asynchronously
        const usageTracker = new UsageTracker(c.env);

        c.executionCtx.waitUntil(
            usageTracker.record(
                {
                    apiKeyId,
                    cachedTokens: 0,
                    completionTokens: 0,
                    costMicrodollars,
                    finishReason: "stop",
                    isStreaming: false,
                    latencyMs,
                    modelApiId: modelInfo.modelApiId,
                    modelId: body.model,
                    orgId,
                    promptTokens: totalTokens,
                    provider: modelInfo.provider,
                    reasoningTokens: 0,
                    requestId,
                    source: "saas_api",
                    userId,
                },
                c.var.telemetry,
            ),
        );

        // Build response in OpenAI format
        const data = embeddings.map((embedding, index) => {
            return {
                embedding: body.encoding_format === "base64" ? float32ArrayToBase64(embedding) : embedding,
                index,
                object: "embedding" as const,
            };
        });

        return c.json(
            {
                data,
                model: body.model,
                object: "list",
                usage: {
                    prompt_tokens: totalTokens,
                    total_tokens: totalTokens,
                },
            },
            200,
        );
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        return c.json({ error: { ...toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId }), type: "server_error" } }, 502);
    }
});

embeddingsRouter.get("/v1/embeddings/models", (c) => {
    const models = Object.entries(EMBEDDING_MODELS).map(([id, info]) => {
        return {
            created: 0,
            dimensions: info.dimensions,
            id,
            object: "model",
            owned_by: info.provider,
            provider: info.provider,
        };
    });

    return c.json({ data: models, object: "list" });
});

/**
 * Rough token estimate: ~4 chars per token (OpenAI-style approximation).
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Encode a float array as a base64 string (little-endian float32).
 */
const float32ArrayToBase64 = (floats: number[]): string => {
    const { buffer } = new Float32Array(floats);
    const bytes = new Uint8Array(buffer);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

// ── Internal HMAC-authenticated endpoint for the backend ────────────────────

const internalRequestSchema = z.object({
    dimensions: z.int().positive().optional(),
    input: z.union([z.string(), z.array(z.string())]),
    model: z.string(),
    orgId: z.string().optional(),
    requestId: z.string(),
    threadId: z.string().optional(),
    userId: z.string(),
});

/**
 * POST /internal/embeddings — HMAC-authenticated embedding endpoint for the backend.
 *
 * Same embedding logic as /v1/embeddings but uses HMAC auth and reports
 * usage back to the backend for billing.
 */
embeddingsRouter.post("/internal/embeddings", internalAuth, async (c) => {
    const rawBody = await c.req.json();
    const parsed = internalRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
        return c.json({ error: { ...toSafeValidationPayload(parsed.error.flatten(), { env: c.env }), type: "invalid_request_error" } }, 400);
    }

    const body = parsed.data;
    const startTime = Date.now();

    const modelInfo = EMBEDDING_MODELS[body.model];

    if (!modelInfo) {
        return c.json(
            {
                error: {
                    message: `Embedding model '${body.model}' not found.`,
                    type: "invalid_request_error",
                },
            },
            400,
        );
    }

    let apiKey: string;

    try {
        apiKey = resolveApiKey(modelInfo.provider, c.env);
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        return c.json(
            {
                error: {
                    ...toSafeErrorPayload(error, { code: "PROVIDER_KEY_ERROR", env: c.env, requestId: body.requestId }),
                    type: "server_error",
                },
            },
            500,
        );
    }

    try {
        const model = await createEmbeddingModel(modelInfo.provider, modelInfo.modelApiId, apiKey);
        const inputs = typeof body.input === "string" ? [body.input] : body.input;

        let embeddings: number[][];
        let totalTokens: number;

        if (inputs.length === 1) {
            const result = await embed({ model, value: inputs[0]! });

            embeddings = [result.embedding];
            totalTokens = result.usage?.tokens ?? estimateTokens(inputs[0]!);
        } else {
            const result = await embedMany({ model, values: inputs });

            embeddings = result.embeddings;
            totalTokens = result.usage?.tokens ?? inputs.reduce((accumulator, t) => accumulator + estimateTokens(t), 0);
        }

        const latencyMs = Date.now() - startTime;
        const costMicrodollars = Math.round((totalTokens / 1_000_000) * modelInfo.costPer1MTokensMicrodollars);

        // Track usage + report to the backend for billing
        const usageTracker = new UsageTracker(c.env);
        const usageReporter = new UsageReporter(c.env);

        c.executionCtx.waitUntil(
            Promise.all([
                usageTracker.record(
                    {
                        cachedTokens: 0,
                        completionTokens: 0,
                        costMicrodollars,
                        finishReason: "stop",
                        isStreaming: false,
                        latencyMs,
                        modelApiId: modelInfo.modelApiId,
                        modelId: body.model,
                        orgId: body.orgId,
                        promptTokens: totalTokens,
                        provider: modelInfo.provider,
                        reasoningTokens: 0,
                        requestId: body.requestId,
                        source: "internal",
                        userId: body.userId,
                    },
                    c.var.telemetry,
                ),
                usageReporter.report({
                    // Platform env keys only on this route — never BYOK.
                    billingMode: "platform",
                    completionTokens: 0,
                    costMicrodollars,
                    modelId: body.model,
                    orgId: body.orgId,
                    promptTokens: totalTokens,
                    requestId: body.requestId,
                    userId: body.userId,
                }),
            ]),
        );

        return c.json(
            {
                dimensions: modelInfo.dimensions,
                embeddings,
                model: body.model,
                usage: { totalTokens },
            },
            200,
        );
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        return c.json(
            { error: { ...toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId: body.requestId }), type: "server_error" } },
            502,
        );
    }
});

export { embeddingsRouter };
