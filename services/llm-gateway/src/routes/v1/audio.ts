/**
 * POST /v1/audio/speech         — OpenAI-compatible TTS endpoint
 * POST /v1/audio/transcriptions — OpenAI-compatible STT endpoint
 * POST /v1/audio/translations   — OpenAI-compatible audio translation to English
 * GET  /v1/audio/models         — list available audio models
 *
 * Binary audio streaming for TTS; multipart/form-data upload for STT.
 * Character count tracked for TTS billing; audio duration tracked for STT billing.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { experimental_generateSpeech, experimental_transcribe } from "ai";
import type { Context } from "hono";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError, toSafeErrorPayload, toSafeValidationPayload } from "../../lib/errors.js";
import { bearerAuth } from "../../middleware/auth.js";
import { expensiveEndpointRateLimit } from "../../middleware/rate-limit.js";
import { createSpeechModel, createTranscriptionModel, STT_MODELS, TTS_MODELS } from "../../providers/audio-factory.js";
import { resolveApiKey } from "../../providers/factory.js";
import { UsageTracker } from "../../usage/tracker.js";

const audioRouter = new OpenAPIHono<HonoEnv>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const speechRequestSchema = z.object({
    input: z.string().min(1).max(4096),
    instructions: z.string().optional(),
    model: z.string(),
    response_format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional().default("mp3"),
    speed: z.number().min(0.25).max(4).optional().default(1),
    voice: z.string().optional().default("alloy"),
});

// ---------------------------------------------------------------------------
// Middleware — apply Bearer auth to all /v1/audio/* routes
// ---------------------------------------------------------------------------

audioRouter.use("/v1/audio/*", bearerAuth);
audioRouter.use("/v1/audio/*", expensiveEndpointRateLimit({ bucket: "audio" }));

// ---------------------------------------------------------------------------
// POST /v1/audio/speech — Text-to-Speech
// ---------------------------------------------------------------------------

audioRouter.post("/v1/audio/speech", async (c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const rawBody = await c.req.json();
    const parsed = speechRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
        return c.json({ error: { ...toSafeValidationPayload(parsed.error.flatten(), { env: c.env, requestId }), type: "invalid_request_error" } }, 400);
    }

    const body = parsed.data;
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const startTime = Date.now();

    const modelInfo = TTS_MODELS[body.model];

    if (!modelInfo) {
        return c.json(
            {
                error: {
                    message: `TTS model '${body.model}' not found. Use GET /v1/audio/models to see available models.`,
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
        const model = await createSpeechModel(modelInfo.provider, modelInfo.modelApiId, apiKey);

        const result = await experimental_generateSpeech({
            instructions: body.instructions,
            model,
            outputFormat: body.response_format,
            speed: body.speed,
            text: body.input,
            voice: body.voice,
        });

        const latencyMs = Date.now() - startTime;
        const charCount = body.input.length;
        const costMicrodollars = Math.round((charCount / 1000) * modelInfo.costPer1KCharsMicrodollars);

        // Track usage asynchronously — use promptTokens for character count billing
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
                    promptTokens: charCount,
                    provider: modelInfo.provider,
                    reasoningTokens: 0,
                    requestId,
                    source: "saas_api",
                    userId,
                },
                c.var.telemetry,
            ),
        );

        const mimeTypeMap: Record<string, string> = {
            aac: "audio/aac",
            flac: "audio/flac",
            mp3: "audio/mpeg",
            opus: "audio/opus",
            pcm: "audio/pcm",
            wav: "audio/wav",
        };

        const contentType = mimeTypeMap[body.response_format] ?? "audio/mpeg";
        const audioData = result.audio.uint8Array;

        return new Response(audioData, {
            headers: {
                "Content-Length": audioData.byteLength.toString(),
                "Content-Type": contentType,
                "X-Request-Id": requestId,
            },
        });
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        return c.json({ error: { ...toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId }), type: "server_error" } }, 502);
    }
});

// ---------------------------------------------------------------------------
// POST /v1/audio/transcriptions — Speech-to-Text
// ---------------------------------------------------------------------------

audioRouter.post("/v1/audio/transcriptions", async (c) => handleTranscription(c, "transcribe"));

// ---------------------------------------------------------------------------
// POST /v1/audio/translations — Speech-to-English translation
// ---------------------------------------------------------------------------

audioRouter.post("/v1/audio/translations", async (c) => handleTranscription(c, "translate"));

// ---------------------------------------------------------------------------
// GET /v1/audio/models — List available TTS and STT models
// ---------------------------------------------------------------------------

audioRouter.get("/v1/audio/models", (c) => {
    const tts = Object.entries(TTS_MODELS).map(([id, info]) => {
        return {
            cost_per_1k_chars_microdollars: info.costPer1KCharsMicrodollars,
            id,
            object: "model",
            owned_by: info.provider,
            type: "tts",
        };
    });

    const stt = Object.entries(STT_MODELS).map(([id, info]) => {
        return {
            cost_per_minute_microdollars: info.costPerMinuteMicrodollars,
            id,
            object: "model",
            owned_by: info.provider,
            type: "stt",
        };
    });

    return c.json({ data: [...tts, ...stt], object: "list" });
});

// ---------------------------------------------------------------------------
// Shared transcription handler (used by both /transcriptions and /translations)
// ---------------------------------------------------------------------------

async function handleTranscription(c: Context<HonoEnv>, task: "transcribe" | "translate") {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const startTime = Date.now();

    let formData: FormData;

    try {
        formData = await c.req.formData();
    } catch {
        return c.json({ error: { message: "Request must be multipart/form-data", type: "invalid_request_error" } }, 400);
    }

    const modelId = (formData.get("model") as string | null) ?? "whisper-large-v3";
    const language = (formData.get("language") as string | null) ?? undefined;
    const prompt = (formData.get("prompt") as string | null) ?? undefined;
    const responseFormat = (formData.get("response_format") as string | null) ?? "json";
    const temperature = formData.get("temperature") ? Number(formData.get("temperature")) : undefined;
    const audioFileEntry = formData.get("file");

    if (!audioFileEntry || typeof audioFileEntry === "string") {
        return c.json({ error: { message: "Missing required field: file (must be an audio File)", type: "invalid_request_error" } }, 400);
    }

    // At this point audioFileEntry is a File (Blob with name) in Workers/browser environments
    const audioFile = audioFileEntry as File;

    // Reject oversized uploads — the file is read fully into Worker memory
    // before being forwarded to the provider. OpenAI's STT cap is 25 MiB; we
    // mirror that limit. 413 (Payload Too Large) is the appropriate status.
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

    if (audioFile.size > MAX_AUDIO_BYTES) {
        return c.json(
            {
                error: {
                    message: `Audio file exceeds maximum size of ${MAX_AUDIO_BYTES} bytes (got ${audioFile.size})`,
                    type: "invalid_request_error",
                },
            },
            413,
        );
    }

    // For translations: only OpenAI's whisper-1 supports the translate task via direct API.
    // Route translations to openai/whisper-1 when a groq model is requested and surface
    // the swap to the caller via X-Model-Used header so usage attribution is honest.
    let effectiveModelId = modelId;
    let isModelSwapped = false;

    if (task === "translate" && STT_MODELS[modelId]?.provider === "groq") {
        effectiveModelId = "whisper-1";
        isModelSwapped = true;
    }

    const modelInfo = STT_MODELS[effectiveModelId];

    if (!modelInfo) {
        return c.json(
            {
                error: {
                    message: `STT model '${modelId}' not found. Use GET /v1/audio/models to see available models.`,
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
        const model = await createTranscriptionModel(modelInfo.provider, modelInfo.modelApiId, apiKey);
        const audioBytes = await audioFile.arrayBuffer();

        let providerOptions;

        if (task === "translate") {
            providerOptions = { openai: { task: "translate" } };
        } else if (language || prompt || temperature !== undefined) {
            providerOptions = { groq: { language, prompt, temperature }, openai: { language, prompt, temperature } };
        }

        const result = await experimental_transcribe({
            audio: new Uint8Array(audioBytes),
            model,
            providerOptions,
        });

        const latencyMs = Date.now() - startTime;
        // Estimate audio duration from file size: ~16KB/s for typical compressed audio
        const estimatedDurationSeconds = result.durationInSeconds ?? audioFile.size / 16_384;
        const estimatedDurationMinutes = estimatedDurationSeconds / 60;
        const costMicrodollars = Math.round(estimatedDurationMinutes * modelInfo.costPerMinuteMicrodollars);

        // Track usage asynchronously — use promptTokens for audio duration seconds
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
                    // Track the model that actually served the request so usage_log rows
                    // are consistent with provider/modelApiId rather than the user's
                    // (possibly swapped) request.
                    modelId: effectiveModelId,
                    orgId,
                    promptTokens: Math.round(estimatedDurationSeconds),
                    provider: modelInfo.provider,
                    reasoningTokens: 0,
                    requestId,
                    source: "saas_api",
                    userId,
                },
                c.var.telemetry,
            ),
        );

        const responseHeaders: Record<string, string> = { "X-Model-Used": effectiveModelId, "X-Request-Id": requestId };

        if (isModelSwapped) {
            responseHeaders["X-Model-Swapped-From"] = modelId;
        }

        // Respond in the requested format
        if (responseFormat === "text") {
            return new Response(result.text, { headers: { ...responseHeaders, "Content-Type": "text/plain" } });
        }

        if (responseFormat === "verbose_json") {
            const payload = {
                duration: result.durationInSeconds ?? estimatedDurationSeconds,
                language: result.language ?? language ?? "unknown",
                model_used: effectiveModelId,
                task: task === "translate" ? "translate" : "transcribe",
                text: result.text,
                ...(isModelSwapped && { model_requested: modelId }),
                segments: result.segments?.map((seg, index) => {
                    return {
                        end: seg.endSecond,
                        id: index,
                        start: seg.startSecond,
                        text: seg.text,
                    };
                }),
            };

            return Response.json(payload, { headers: { ...responseHeaders, "Content-Type": "application/json" } });
        }

        // Default: json
        const payload = isModelSwapped ? { model_requested: modelId, model_used: effectiveModelId, text: result.text } : { text: result.text };

        return Response.json(payload, { headers: { ...responseHeaders, "Content-Type": "application/json" } });
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, type: "server_error" } }, error.statusCode as 502);
        }

        return c.json({ error: { ...toSafeErrorPayload(error, { code: "PROVIDER_ERROR", env: c.env, requestId }), type: "server_error" } }, 502);
    }
}

export { audioRouter };
