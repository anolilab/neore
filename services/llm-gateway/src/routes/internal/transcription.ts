/**
 * POST /internal/transcription — speech-to-text for the backend, nothing persisted.
 *
 * The mobile composer's voice input sends one recorded clip through the backend
 * (`voice/transcription.ts:transcribeClip`) to here. The clip arrives as base64,
 * goes to the provider, and only the text comes back; the audio is never
 * written anywhere. The cost is per second of audio, from the duration the
 * provider reports (the client's own figure only when the provider gives
 * none), and is reported to the backend like every other call. A
 * `providerApiKey` is the user's own key: the call is billed `byok`.
 *
 * The SDK reads the clip's format from its bytes. HMAC-authenticated like the
 * rest of `/internal/*`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { experimental_transcribe } from "ai";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError } from "../../lib/errors.js";
import { internalAuth } from "../../middleware/auth.js";
import { resolveApiKey } from "../../providers/factory.js";
import { isMockLlmEnabled } from "../../providers/mock-model.js";
import { resolveBillingMode, resolveByokFeeRate } from "../../usage/billing.js";
import { UsageReporter } from "../../usage/reporter.js";
import { UsageTracker } from "../../usage/tracker.js";

export const TRANSCRIPTION_MODEL_ID = "openai/whisper-1";

const TRANSCRIPTION_MODEL_API_ID = "whisper-1";

/** $0.006 per minute of audio. */
export const TRANSCRIPTION_COST_PER_SECOND_MICRODOLLARS = 100;

/** Longest base64 clip accepted: about a minute of the app's compressed mono recording, with room to spare. */
export const MAX_TRANSCRIPTION_AUDIO_BASE64 = 2_000_000;

const TRANSCRIPTION_TIMEOUT_MS = 45_000;

const transcriptionRequestSchema = z.object({
    audio: z.string().min(1).max(MAX_TRANSCRIPTION_AUDIO_BASE64),
    durationSeconds: z.number().positive().max(120),
    orgId: z.string().max(200).optional(),
    providerApiKey: z.string().min(1).max(500).optional(),
    requestId: z.string().min(1).max(200),
    userId: z.string().min(1).max(200),
});

/** A started second is a whole second. */
export const transcriptionCostMicrodollars = (seconds: number): number => Math.ceil(seconds) * TRANSCRIPTION_COST_PER_SECOND_MICRODOLLARS;

const transcriptionRouter = new OpenAPIHono<HonoEnv>();

transcriptionRouter.use("/internal/transcription", internalAuth);

transcriptionRouter.post("/internal/transcription", async (c) => {
    const parsed = transcriptionRequestSchema.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
        return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid transcription request" } }, 400);
    }

    const body = parsed.data;

    if (isMockLlmEnabled(c.env)) {
        return c.json({ costMicrodollars: 0, seconds: body.durationSeconds, text: "Mock transcription" });
    }

    let apiKey: string;

    try {
        apiKey = resolveApiKey("openai", c.env, body.providerApiKey);
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json(error.toJSON(), error.statusCode);
        }

        return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to resolve API key" } }, 500);
    }

    const startTime = Date.now();

    try {
        const { createOpenAI } = await import("@ai-sdk/openai");
        const result = await experimental_transcribe({
            abortSignal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
            audio: body.audio,
            model: createOpenAI({ apiKey }).transcription(TRANSCRIPTION_MODEL_API_ID),
        });
        const seconds = result.durationInSeconds ?? body.durationSeconds;
        const costMicrodollars = transcriptionCostMicrodollars(seconds);

        c.executionCtx.waitUntil(
            Promise.allSettled([
                new UsageTracker(c.env).record(
                    {
                        cachedTokens: 0,
                        completionTokens: 0,
                        costMicrodollars,
                        finishReason: "stop",
                        isStreaming: false,
                        latencyMs: Date.now() - startTime,
                        modelApiId: TRANSCRIPTION_MODEL_API_ID,
                        modelId: TRANSCRIPTION_MODEL_ID,
                        orgId: body.orgId,
                        // Seconds of audio stand in for tokens.
                        promptTokens: Math.ceil(seconds),
                        provider: "openai",
                        reasoningTokens: 0,
                        requestId: body.requestId,
                        source: "internal",
                        userId: body.userId,
                    },
                    c.var.telemetry,
                ),
                new UsageReporter(c.env).report({
                    billingMode: resolveBillingMode({ isCustom: false, providerApiKey: body.providerApiKey }),
                    byokFeeRate: resolveByokFeeRate(c.env.BYOK_FEE_RATE),
                    completionTokens: 0,
                    costMicrodollars,
                    modelId: TRANSCRIPTION_MODEL_ID,
                    orgId: body.orgId,
                    promptTokens: Math.ceil(seconds),
                    requestId: body.requestId,
                    userId: body.userId,
                }),
            ]),
        );

        return c.json({ costMicrodollars, seconds, text: result.text });
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json(error.toJSON(), error.statusCode);
        }

        return c.json({ error: { code: "PROVIDER_ERROR", message: error instanceof Error ? error.message : "Unknown provider error" } }, 502);
    }
});

export { transcriptionRouter };
