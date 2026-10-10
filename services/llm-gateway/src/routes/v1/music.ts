/**
 * Music generation routes — mirrors the video router (see ./video.ts for the
 * full architecture writeup).
 *
 *   POST /v1/music                       Submit an async music job
 *   GET  /v1/music/:jobId                Poll job status
 *   GET  /v1/music/:jobId/content        Stream the rendered audio bytes
 *   GET  /v1/music/models                List available music models
 *
 * Music renders are typically faster than video (&lt;30s vs minutes) but use
 * the same queue plumbing so retries, DLQs, and telemetry are uniform across
 * the two render queues.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError, toSafeErrorPayload, toSafeValidationPayload } from "../../lib/errors.js";
import { bearerAuth } from "../../middleware/auth.js";
import { expensiveEndpointRateLimit } from "../../middleware/rate-limit.js";
import { resolveApiKey } from "../../providers/factory.js";
import { MUSIC_MODELS } from "../../providers/music-factory.js";
import type { MusicJobState } from "./music-render.js";
import { buildContentUrl, buildPollingUrl, fireWebhook, getJob, putJob, RENDER_STALL_THRESHOLD_MS } from "./music-render.js";
import type { MusicRenderMessage } from "./music-types.js";
import { MUSIC_RENDER_MESSAGE_VERSION, MUSIC_RENDER_SECRET_TTL_SECONDS, musicRenderSecretKvKey } from "./music-types.js";
import { resolveCanonicalOrigin } from "./video.js";

const musicRouter = new OpenAPIHono<HonoEnv>();

// ─── Schemas ────────────────────────────────────────────────────────────────────

const generateRequestSchema = z.object({
    callback_url: z.url().startsWith("https://").optional(),
    duration: z.number().min(1).max(300).optional(),
    model: z.string(),
    negative_prompt: z.string().max(2000).optional(),
    prompt: z.string().min(1).max(2000),
    provider: z
        .object({
            options: z.record(z.string(), z.looseObject({ parameters: z.record(z.string(), z.unknown()).optional() })).optional(),
        })
        .optional(),
    seed: z.int().nonnegative().optional(),
});

// ─── Middleware ─────────────────────────────────────────────────────────────────

musicRouter.use("/v1/music/*", bearerAuth);
// Music renders cost less than video but are still provider-billed; reuse
// the expensive-endpoint limiter with the dedicated "music" bucket so
// abuse is contained without sharing video's tighter budget.
musicRouter.use("/v1/music/*", expensiveEndpointRateLimit({ bucket: "music", tierMultiplier: 1 }));

// ─── POST /v1/music ─────────────────────────────────────────────────────────────

musicRouter.post("/v1/music", async (c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const rawBody = await c.req.json();
    const parsed = generateRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
        return c.json({ error: toSafeValidationPayload(parsed.error.flatten(), { env: c.env, requestId }) }, 400);
    }

    const body = parsed.data;
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const isByok = c.get("usesOwnKeys") === true;
    const jobId = crypto.randomUUID();
    const origin = resolveCanonicalOrigin(c.env, c.req.url);

    const modelInfo = MUSIC_MODELS[body.model];

    if (!modelInfo) {
        return c.json({ error: `Music model '${body.model}' not found. Use GET /v1/music/models to see available models.` }, 400);
    }

    if (body.negative_prompt && !modelInfo.supportsNegativePrompt) {
        return c.json({ error: `Model '${body.model}' does not support negative_prompt.` }, 400);
    }

    if (body.duration !== undefined && modelInfo.maxDurationSeconds > 0 && body.duration > modelInfo.maxDurationSeconds) {
        return c.json({ error: `Duration ${body.duration}s exceeds model max of ${modelInfo.maxDurationSeconds}s.` }, 400);
    }

    let apiKey: string;

    try {
        apiKey = resolveApiKey(modelInfo.provider, c.env);
    } catch (error) {
        if (error instanceof GatewayError) {
            return c.json({ error: { code: error.code, message: error.message, requestId } }, 502);
        }

        return c.json({ error: toSafeErrorPayload(error, { code: "PROVIDER_NOT_CONFIGURED", env: c.env, requestId }) }, 500);
    }

    const job: MusicJobState = {
        callbackUrl: body.callback_url,
        createdAt: Date.now(),
        id: jobId,
        isByok,
        modelApiId: modelInfo.modelApiId,
        modelId: body.model,
        orgId,
        prompt: body.prompt,
        provider: modelInfo.provider,
        status: "pending",
        userId,
    };

    await putJob(c.env.RATE_LIMIT_KV, job);

    try {
        await c.env.CACHE_KV.put(musicRenderSecretKvKey(jobId), apiKey, {
            expirationTtl: MUSIC_RENDER_SECRET_TTL_SECONDS,
        });
    } catch (error) {
        console.error("[music] failed to stash render secret:", error);

        await putJob(c.env.RATE_LIMIT_KV, { ...job, completedAt: Date.now(), errorMessage: "Failed to persist render credentials", status: "failed" }).catch(
            () => {},
        );

        return c.json(
            {
                error: {
                    code: "QUEUE_ENQUEUE_FAILED",
                    message: "Failed to prepare music render job. Please retry.",
                    requestId,
                },
            },
            503,
        );
    }

    // Persist to D1 before enqueue (same rationale as video.ts — avoid the
    // consumer-races-producer-insert window).
    await c.env.USAGE_DB.prepare(
        `INSERT INTO music_jobs (id, user_id, org_id, api_key_id, model_id, provider, model_api_id, prompt, negative_prompt, duration_seconds, seed, callback_url, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
        .bind(
            jobId,
            userId,
            orgId ?? null,
            apiKeyId ?? null,
            body.model,
            modelInfo.provider,
            modelInfo.modelApiId,
            body.prompt,
            body.negative_prompt ?? null,
            body.duration ?? null,
            body.seed ?? null,
            body.callback_url ?? null,
        )
        .run()
        .catch((error) => console.error("[music] failed to insert music_job:", error));

    const message: MusicRenderMessage = {
        _version: MUSIC_RENDER_MESSAGE_VERSION,
        apiKeyId,
        body,
        enqueuedAt: Date.now(),
        isByok,
        jobId,
        modelInfo: {
            costPerMusicGenerationMicrodollars: modelInfo.costPerMusicGenerationMicrodollars,
            modelApiId: modelInfo.modelApiId,
            provider: modelInfo.provider,
        },
        orgId,
        origin,
        parentTraceparent: c.req.header("traceparent"),
        requestId,
        userId,
    };

    try {
        await c.env.MUSIC_RENDER_QUEUE.send(message);
    } catch (error) {
        console.error("[music] failed to enqueue render:", error);

        await putJob(c.env.RATE_LIMIT_KV, { ...job, completedAt: Date.now(), errorMessage: "Failed to enqueue render job", status: "failed" }).catch(() => {});
        await c.env.CACHE_KV.delete(musicRenderSecretKvKey(jobId)).catch(() => {});

        return c.json(
            {
                error: {
                    code: "QUEUE_ENQUEUE_FAILED",
                    message: "Failed to enqueue music render job. Please retry.",
                    requestId,
                },
            },
            503,
        );
    }

    return c.json(
        {
            id: jobId,
            polling_url: buildPollingUrl(origin, jobId),
            status: "pending" as const,
        },
        202,
    );
});

/** Poll response — optional fields are filled per terminal status. */
interface PollResponse {
    duration_seconds?: number;
    error?: string;
    generation_id: string;
    id: string;
    model: string;
    polling_url: string;
    sample_rate?: number;
    status: string;
    unsigned_urls?: string[];
    usage?: { cost: string; is_byok: boolean };
}

// ─── GET /v1/music/:jobId ──────────────────────────────────────────────────────

musicRouter.get("/v1/music/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const userId = c.get("userId");
    let job = await getJob(c.env.RATE_LIMIT_KV, jobId);

    if (!job || job.userId !== userId) {
        return c.json({ error: `Music generation job '${jobId}' not found` }, 404);
    }

    // Stall recovery — defensive net for the case where the consumer hit a
    // runtime limit AND queue retry/DLQ also lost the job. Rare with queues.
    if (job.status === "in_progress" && job.startedAt && Date.now() - job.startedAt > RENDER_STALL_THRESHOLD_MS) {
        const failed: MusicJobState = {
            ...job,
            completedAt: Date.now(),
            errorMessage: "Render stalled and was reaped after exceeding the stall threshold.",
            status: "failed",
        };

        await putJob(c.env.RATE_LIMIT_KV, failed).catch(() => {});
        await c.env.USAGE_DB.prepare(
            `UPDATE music_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ? AND status = 'in_progress'`,
        )
            .bind(failed.errorMessage, jobId)
            .run()
            .catch(() => {});

        if (failed.callbackUrl) {
            c.executionCtx.waitUntil(
                fireWebhook(failed.callbackUrl, jobId, "failed", {
                    error: failed.errorMessage,
                    generation_id: jobId,
                    model: failed.modelId,
                    polling_url: buildPollingUrl(resolveCanonicalOrigin(c.env, c.req.url), jobId),
                }),
            );
        }

        job = failed;
    }

    const origin = resolveCanonicalOrigin(c.env, c.req.url);
    const pollingUrl = buildPollingUrl(origin, jobId);

    const response: PollResponse = {
        generation_id: job.id,
        id: job.id,
        model: job.modelId,
        polling_url: pollingUrl,
        status: job.status,
    };

    if (job.status === "completed" && job.r2Key) {
        response.unsigned_urls = [buildContentUrl(origin, jobId)];
        response.usage = {
            cost: ((job.costMicrodollars ?? 0) / 1_000_000).toFixed(6),
            is_byok: job.isByok ?? false,
        };

        if (job.sampleRate) response.sample_rate = job.sampleRate;

        if (job.durationSeconds) response.duration_seconds = job.durationSeconds;
    }

    if (job.status === "failed") {
        response.error = job.errorMessage ?? "Generation failed";
    }

    return c.json(response);
});

// ─── GET /v1/music/:jobId/content ──────────────────────────────────────────────

musicRouter.get("/v1/music/:jobId/content", async (c) => {
    const jobId = c.req.param("jobId");
    const userId = c.get("userId");

    const job = await getJob(c.env.RATE_LIMIT_KV, jobId);

    if (!job || job.userId !== userId) {
        return c.json({ error: `Music generation job '${jobId}' not found` }, 404);
    }

    if (job.status !== "completed" || !job.r2Key) {
        return c.json({ error: `Job is ${job.status}; content not available yet` }, 409);
    }

    const object = await c.env.MUSIC_BUCKET.get(job.r2Key);

    if (!object) {
        return c.json({ error: "Rendered audio has expired or been deleted" }, 410);
    }

    return new Response(object.body, {
        headers: {
            "Cache-Control": "private, max-age=3600",
            "Content-Length": String(object.size),
            "Content-Type": object.httpMetadata?.contentType ?? job.mimeType ?? "audio/wav",
        },
    });
});

// ─── GET /v1/music/models ──────────────────────────────────────────────────────

musicRouter.get("/v1/music/models", (c) => {
    const data = Object.values(MUSIC_MODELS).map((info) => {
        return {
            allowed_passthrough_parameters: info.allowedPassthroughParameters,
            canonical_slug: info.canonicalSlug,
            created: info.created,
            description: info.description,
            id: info.canonicalSlug,
            max_duration_seconds: info.maxDurationSeconds,
            name: info.name,
            supported_audio_formats: info.supportedAudioFormats,
            supported_sample_rates: info.supportedSampleRates,
            supports_negative_prompt: info.supportsNegativePrompt,
        };
    });

    return c.json({ data });
});

export { musicRouter };
