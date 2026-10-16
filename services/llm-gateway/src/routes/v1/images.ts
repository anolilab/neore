/**
 * POST /v1/images/generations — OpenAI-compatible image generation endpoint.
 * GET  /v1/images/models      — list available image models.
 *
 * Routes to OpenAI (DALL-E, GPT-Image) or fal.ai (FLUX, Recraft) based on model.
 * Returns OpenAI-compatible response: `{ created, data: [{ b64_json, url, revised_prompt }] }`.
 * Usage tracked per image with cost deducted from user balance.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { markAiGeneratedImage, withPngOutput } from "@neore/ai/provenance";
import { generateImage } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError, toSafeErrorPayload, toSafeValidationPayload } from "../../lib/errors.js";
import { buildFalReferenceImageInput } from "../../lib/reference-image-mapping.js";
import { bearerAuth } from "../../middleware/auth.js";
import { expensiveEndpointRateLimit } from "../../middleware/rate-limit.js";
import { resolveApiKey } from "../../providers/factory.js";
import { createImageModel, IMAGE_MODELS } from "../../providers/image-factory.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

const imagesRouter = new OpenAPIHono<HonoEnv>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const generateRequestSchema = z.object({
    model: z.string().default("dall-e-3"),
    n: z.int().min(1).max(10).optional().default(1),
    prompt: z.string().min(1).max(4000),
    quality: z.enum(["standard", "hd", "high", "medium", "low"]).optional(),

    /**
     * Ordered list of reference image URLs for multi-ref-capable models
     * (Nano-Banana, FLUX Redux, IP-Adapter, etc.). The per-model cap lives on
     * `IMAGE_MODELS[model].maxReferenceImages`; extras are silently dropped.
     * For single-ref models only the first URL is used.
     */
    reference_images: z.array(z.url()).max(4).optional(),
    response_format: z.enum(["url", "b64_json"]).optional().default("b64_json"),
    size: z.string().optional(),
    style: z.enum(["vivid", "natural"]).optional(),
    user: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Base64 in, base64 out, with the AI-generated marker applied to the bytes. */
const markBase64Image = (base64: string): string => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
    const marked = markAiGeneratedImage(bytes);

    if (marked === bytes) {
        return base64;
    }

    let binary = "";

    for (let offset = 0; offset < marked.byteLength; offset += 0x80_00) {
        binary += String.fromCodePoint(...marked.subarray(offset, offset + 0x80_00));
    }

    return btoa(binary);
};

imagesRouter.use("/v1/images/*", bearerAuth);

// ---------------------------------------------------------------------------
// POST /v1/images/generations
// ---------------------------------------------------------------------------

imagesRouter.post("/v1/images/generations", expensiveEndpointRateLimit({ bucket: "images" }), async (c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const rawBody = await c.req.json();
    const parsed = generateRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
        return c.json({ error: { ...toSafeValidationPayload(parsed.error.flatten(), { env: c.env, requestId }), type: "invalid_request_error" } }, 400);
    }

    const body = parsed.data;
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const startTime = Date.now();

    const modelInfo = IMAGE_MODELS[body.model];

    if (!modelInfo) {
        return c.json(
            {
                error: {
                    message: `Image model '${body.model}' not found. Use GET /v1/images/models to see available models.`,
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
            return c.json({ error: { message: error.message, type: "server_error" } }, 502);
        }

        return c.json({ error: { message: "Failed to resolve provider API key", type: "server_error" } }, 500);
    }

    try {
        const model = await createImageModel(modelInfo.provider, modelInfo.modelApiId, apiKey);

        // Reference-image fields are provider-specific. FAL accepts `image_url`
        // (always) and `image_urls` (multi-ref models only). OpenAI/BFL paths
        // don't yet have a reference-image contract on this endpoint, so refs
        // are silently dropped there — callers should pre-check
        // `IMAGE_MODELS[model].maxReferenceImages` to know what's accepted.
        const falReferenceInput = modelInfo.provider === "fal" ? buildFalReferenceImageInput(modelInfo.maxReferenceImages, body.reference_images) : {};

        const requestedSize = body.size;

        const result = await generateImage({
            model,
            n: body.n,
            prompt: body.prompt,
            ...(requestedSize && { size: requestedSize as `${number}x${number}` }),
            // PNG where the provider takes a format: the marker cannot mark WebP (Art. 50(2)).
            providerOptions: withPngOutput(
                {
                    openai: {
                        ...(body.quality && { quality: body.quality }),
                        ...(body.style && { style: body.style }),
                    },
                    ...(Object.keys(falReferenceInput).length > 0 && { fal: { ...falReferenceInput } }),
                },
                modelInfo.provider,
                modelInfo.modelApiId,
            ),
        });

        const latencyMs = Date.now() - startTime;
        const imageCount = result.images.length;
        const costMicrodollars = imageCount * modelInfo.costPerImageMicrodollars;

        // Track usage asynchronously
        const usageTracker = new UsageTracker(c.env);

        c.executionCtx.waitUntil(
            Promise.allSettled([
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
                        promptTokens: imageCount,
                        provider: modelInfo.provider,
                        reasoningTokens: 0,
                        requestId,
                        source: "saas_api",
                        userId,
                    },
                    c.var.telemetry,
                ),
                ...(costMicrodollars > 0
                    ? [
                          new UsageReporter(c.env).report({
                              // Platform env keys only on this route — never BYOK.
                              billingMode: "platform",
                              completionTokens: 0,
                              costMicrodollars,
                              modelId: body.model,
                              orgId,
                              promptTokens: imageCount,
                              requestId,
                              userId,
                          }),
                      ]
                    : []),
            ]),
        );

        // Build OpenAI-compatible response
        // Art. 50(2): every generated image leaves the gateway marked as AI-generated.
        const data = result.images.map((img) => {
            const base64 = markBase64Image(img.base64);

            return {
                b64_json: body.response_format === "b64_json" ? base64 : undefined,
                revised_prompt: undefined as string | undefined,
                url: body.response_format === "url" ? `data:${img.mediaType};base64,${base64}` : undefined,
            };
        });

        return c.json(
            {
                created: Math.floor(Date.now() / 1000),
                data,
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

// ---------------------------------------------------------------------------
// GET /v1/images/models — List available image models
// ---------------------------------------------------------------------------

imagesRouter.get("/v1/images/models", (c) => {
    const models = Object.entries(IMAGE_MODELS).map(([id, info]) => {
        return {
            cost_per_image_microdollars: info.costPerImageMicrodollars,
            id,
            object: "model",
            owned_by: info.provider,
        };
    });

    return c.json({ data: models, object: "list" });
});

export { imagesRouter };
