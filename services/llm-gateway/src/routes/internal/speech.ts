/**
 * POST /internal/speech — text-to-speech for the backend, nothing persisted.
 *
 * Hands-free voice mode reads replies aloud through this (backend
 * `voice/speech.ts:synthesizeSpeech`). The model is a registry
 * `text-to-speech` entry priced per 1,000 characters (`GATEWAY_SPEECH_MODELS`);
 * the audio bytes are the response body, and the cost is reported to the
 * backend like every other call, so it is deducted from the user's credits
 * (`usage/reporter.ts` → `/gateway/usage-report`). A `providerApiKey` is the
 * user's own key: the call is billed `byok`, i.e. only the platform fee.
 *
 * FAL renders the whole clip before answering, so there is nothing to stream
 * here; the client gets its early start by synthesising a reply sentence by
 * sentence instead.
 *
 * HMAC-authenticated like the rest of `/internal/*`. No content-safety pass:
 * the text is meant to be a reply the model already produced through the
 * checked chat path. The client sends it, so it is not guaranteed to be — what
 * bounds abuse is the backend's metering (guests refused, per-call cap, daily
 * character allowance), not a classifier.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { GatewaySpeechModelInfo } from "@neore/ai/models";
import { GATEWAY_SPEECH_MODELS } from "@neore/ai/models";
import { experimental_generateSpeech } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError } from "../../lib/errors.js";
import { internalAuth } from "../../middleware/auth.js";
import { resolveApiKey } from "../../providers/factory.js";
import { isMockLlmEnabled } from "../../providers/mock-model.js";
import { resolveBillingMode, resolveByokFeeRate } from "../../usage/billing.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

/** Longest text one request may synthesise. The backend caps lower; this is the gateway's own bound. */
export const MAX_SPEECH_CHARS = 4096;

/** A FAL render of a few sentences takes seconds; a hung provider must not hold the backend's action. */
const SPEECH_TIMEOUT_MS = 45_000;

const speechRequestSchema = z.object({
    modelId: z.string().min(1).max(200),
    orgId: z.string().max(200).optional(),
    providerApiKey: z.string().min(1).max(500).optional(),
    requestId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
    userId: z.string().min(1).max(200),
    voice: z.string().max(100).optional(),
});

/** What one request costs: proportional to its characters, rounded up to a whole microdollar. */
export const speechCostMicrodollars = (model: Pick<GatewaySpeechModelInfo, "costPerThousandCharsMicrodollars">, chars: number): number =>
    Math.ceil((chars * model.costPerThousandCharsMicrodollars) / 1000);

/** The voice to use: the requested preset when the model has it, else the model's default. */
export const resolveSpeechVoice = (model: Pick<GatewaySpeechModelInfo, "defaultVoice" | "voices">, requested: string | undefined): string | undefined => {
    const wanted = requested?.trim();

    if (wanted && model.voices.includes(wanted)) {
        return wanted;
    }

    return model.defaultVoice;
};

/** Half a second of 8 kHz 8-bit mono silence — what `MOCK_LLM` answers, so dev and e2e never reach FAL. */
const mockSilence = (): Uint8Array => {
    const samples = 4000;
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
        for (let index = 0; index < text.length; index += 1) {
            bytes[offset + index] = text.codePointAt(index) ?? 0;
        }
    };

    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    ascii(36, "data");
    view.setUint32(40, samples, true);
    bytes.fill(128, 44);

    return bytes;
};

const speechRouter = new OpenAPIHono<HonoEnv>();

speechRouter.use("/internal/speech", internalAuth);

speechRouter.post("/internal/speech", async (c) => {
    const parsed = speechRequestSchema.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
        return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid speech request" } }, 400);
    }

    const body = parsed.data;
    const model = GATEWAY_SPEECH_MODELS[body.modelId];

    if (!model) {
        return c.json({ error: { code: "MODEL_UNKNOWN", message: `Speech model ${body.modelId} is not available` } }, 400);
    }

    if (isMockLlmEnabled(c.env)) {
        return new Response(mockSilence(), {
            headers: { "Content-Type": "audio/wav", "x-gateway-cost-microdollars": "0", "X-Request-Id": body.requestId },
        });
    }

    const voice = resolveSpeechVoice(model, body.voice);
    const chars = body.text.length;
    const startTime = Date.now();

    let apiKey: string;

    try {
        apiKey = resolveApiKey(model.provider, c.env, body.providerApiKey);
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json(error.toJSON(), error.statusCode);
        }

        return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to resolve API key" } }, 500);
    }

    const billingMode = resolveBillingMode({ isCustom: false, providerApiKey: body.providerApiKey });

    try {
        const { createFal } = await import("@ai-sdk/fal");
        // A preset-voice model (MiniMax) takes its voice in `voice_setting`; the
        // top-level `voice` is what the rest read.
        const voiceOptions = model.voices.length > 0 ? { providerOptions: { fal: { voice_setting: { voice_id: voice } } } } : { voice };
        const result = await experimental_generateSpeech({
            abortSignal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
            model: createFal({ apiKey }).speech(model.modelApiId),
            text: body.text,
            ...voiceOptions,
        });
        const audio = result.audio.uint8Array;

        if (audio.byteLength === 0) {
            return c.json({ error: { code: "PROVIDER_ERROR", message: "The provider returned no audio" } }, 502);
        }

        const costMicrodollars = speechCostMicrodollars(model, chars);
        const latencyMs = Date.now() - startTime;

        c.executionCtx.waitUntil(
            Promise.allSettled([
                new UsageTracker(c.env).record(
                    {
                        cachedTokens: 0,
                        completionTokens: 0,
                        costMicrodollars,
                        finishReason: "stop",
                        isStreaming: false,
                        latencyMs,
                        modelApiId: model.modelApiId,
                        modelId: body.modelId,
                        orgId: body.orgId,
                        // Characters stand in for tokens, as on `/v1/audio/speech`.
                        promptTokens: chars,
                        provider: model.provider,
                        reasoningTokens: 0,
                        requestId: body.requestId,
                        source: "internal",
                        userId: body.userId,
                    },
                    c.var.telemetry,
                ),
                new UsageReporter(c.env).report({
                    billingMode,
                    byokFeeRate: resolveByokFeeRate(c.env.BYOK_FEE_RATE),
                    completionTokens: 0,
                    costMicrodollars,
                    modelId: body.modelId,
                    orgId: body.orgId,
                    promptTokens: chars,
                    requestId: body.requestId,
                    userId: body.userId,
                }),
            ]),
        );

        return new Response(audio, {
            headers: {
                "Content-Length": String(audio.byteLength),
                "Content-Type": result.audio.mediaType || "audio/mpeg",
                "x-gateway-cost-microdollars": String(costMicrodollars),
                "X-Request-Id": body.requestId,
            },
        });
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json(error.toJSON(), error.statusCode);
        }

        return c.json({ error: { code: "PROVIDER_ERROR", message: error instanceof Error ? error.message : "Unknown provider error" } }, 502);
    }
});

export { speechRouter };
