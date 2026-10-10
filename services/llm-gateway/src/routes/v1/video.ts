/**
 * Video generation routes — OpenRouter-compatible.
 *
 *   POST /v1/videos                       Submit an async video job
 *   GET  /v1/videos/:jobId                Poll job status
 *   GET  /v1/videos/:jobId/content        Stream the rendered video bytes
 *   GET  /v1/videos/models                List available video models
 *
 * Job lifecycle:
 *   pending → in_progress → (completed | failed)
 *
 * Submit returns 202 with `{ id, polling_url, status }`. The render runs as
 * a Cloudflare Queue consumer (see the `queue` handler in src/index.ts) so the
 * render lifecycle is decoupled from the HTTP request lifecycle. This lets
 * renders run to completion without racing the request's CPU/wall-clock
 * budget, gets us free retries + DLQ for transient failures, and gives the
 * render its own telemetry root span via the queue-consumer wrapper.
 *
 * If the request includes `callback_url`, a webhook POST is fired on terminal
 * states with header `X-OpenRouter-Idempotency-Key: {jobId}-{status}`.
 *
 * Model IDs are OpenRouter-style `provider/slug` (e.g. `fal/luma-ray-2`).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { GatewayError, toSafeErrorPayload, toSafeValidationPayload } from "../../lib/errors.js";
import { bearerAuth } from "../../middleware/auth.js";
import { expensiveEndpointRateLimit } from "../../middleware/rate-limit.js";
import { resolveApiKey } from "../../providers/factory.js";
import { VIDEO_MODELS } from "../../providers/video-factory.js";
import type { VideoJobState } from "./video-render.js";
import { buildContentUrl, buildPollingUrl, fireWebhook, getJob, putJob, RENDER_STALL_THRESHOLD_MS } from "./video-render.js";
import type { VideoRenderMessage } from "./video-types.js";
import { VIDEO_RENDER_MESSAGE_VERSION, VIDEO_RENDER_SECRET_TTL_SECONDS, videoRenderSecretKvKey } from "./video-types.js";

/** Matches a single trailing slash, so a configured origin normalises to no trailing slash. */
const TRAILING_SLASH_RE = /\/$/;

/**
 * Origin used for polling/content URLs returned to clients and stamped into
 * webhook payloads. Prefer the operator-configured `PUBLIC_GATEWAY_URL` so
 * an attacker can't spoof the Host header and trick downstream webhooks
 * into pointing at an attacker-controlled origin (same rationale as in
 * env.ts).
 *
 * Falls back to the request origin only when the env var is unset — that
 * branch is for local dev where Host is trusted.
 */
export const resolveCanonicalOrigin = (env: HonoEnv["Bindings"], requestUrl: string): string => {
    const configured = env.PUBLIC_GATEWAY_URL?.replace(TRAILING_SLASH_RE, "");

    if (configured) {
        return configured;
    }

    return new URL(requestUrl).origin;
};

const videoRouter = new OpenAPIHono<HonoEnv>();

// ─── Schemas ────────────────────────────────────────────────────────────────────

const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"]);
const resolutionSchema = z.enum(["480p", "720p", "1080p", "1K", "2K", "4K"]);
const sizeSchema = z.string().regex(/^\d{2,5}x\d{2,5}$/, "size must be WIDTHxHEIGHT");

const imageRefSchema = z.object({
    image_url: z.object({ url: z.url() }),
    type: z.literal("image_url"),
});

const frameImageSchema = imageRefSchema.extend({
    frame_type: z.enum(["first_frame", "last_frame"]),
});

const generateRequestSchema = z.object({
    aspect_ratio: aspectRatioSchema.optional(),
    callback_url: z.url().startsWith("https://").optional(),
    duration: z.int().min(1).max(60).optional(),
    frame_images: z.array(frameImageSchema).max(2).optional(),
    generate_audio: z.boolean().optional().default(true),
    input_references: z.array(imageRefSchema).max(8).optional(),
    model: z.string(),
    prompt: z.string().min(1).max(2000),
    provider: z
        .object({
            options: z.record(z.string(), z.looseObject({ parameters: z.record(z.string(), z.unknown()).optional() })).optional(),
        })
        .optional(),
    resolution: resolutionSchema.optional(),
    seed: z.int().nonnegative().optional(),
    size: sizeSchema.optional(),
});

// ─── Middleware ─────────────────────────────────────────────────────────────────

videoRouter.use("/v1/videos/*", bearerAuth);
// Video generation is the highest cost-per-call provider call we expose;
// keep its bucket tighter than other expensive endpoints.
videoRouter.use("/v1/videos/*", expensiveEndpointRateLimit({ bucket: "video", tierMultiplier: 0.5 }));

// ─── POST /v1/videos ────────────────────────────────────────────────────────────

videoRouter.post("/v1/videos", async (c) => {
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

    const modelInfo = VIDEO_MODELS[body.model];

    if (!modelInfo) {
        return c.json({ error: `Video model '${body.model}' not found. Use GET /v1/videos/models to see available models.` }, 400);
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

    const job: VideoJobState = {
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

    // Stash the resolved provider key in KV under the jobId, away from the
    // queue message body. Cuts the key's exposure from queue retention (≤4d)
    // down to KV TTL (~2h, plenty for any reasonable retry chain). The
    // consumer reads it back via `videoRenderSecretKvKey(jobId)`.
    try {
        await c.env.CACHE_KV.put(videoRenderSecretKvKey(jobId), apiKey, {
            expirationTtl: VIDEO_RENDER_SECRET_TTL_SECONDS,
        });
    } catch (error) {
        console.error("[video] failed to stash render secret:", error);

        await putJob(c.env.RATE_LIMIT_KV, { ...job, completedAt: Date.now(), errorMessage: "Failed to persist render credentials", status: "failed" }).catch(
            () => {},
        );

        return c.json(
            {
                error: {
                    code: "QUEUE_ENQUEUE_FAILED",
                    message: "Failed to prepare video render job. Please retry.",
                    requestId,
                },
            },
            503,
        );
    }

    // Persist to D1 BEFORE enqueueing — otherwise a fast consumer can race
    // the producer's INSERT (consumer does UPDATE-only, never INSERT, so a
    // missed INSERT silently drops the analytics row). The added latency
    // here is one D1 round-trip on the 202 path; cheap for correctness.
    await c.env.USAGE_DB.prepare(
        `INSERT INTO video_jobs (id, user_id, org_id, api_key_id, model_id, provider, model_api_id, prompt, aspect_ratio, resolution, size, duration_seconds, seed, generate_audio, callback_url, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
            body.aspect_ratio ?? null,
            body.resolution ?? null,
            body.size ?? null,
            body.duration ?? null,
            body.seed ?? null,
            body.generate_audio ? 1 : 0,
            body.callback_url ?? null,
        )
        .run()
        .catch((error) => console.error("[video] failed to insert video_job:", error));

    // Enqueue for background render. The queue consumer (Worker's `queue()`
    // handler) picks this up with its own invocation lifecycle, which gives
    // the render its own CPU budget and a fresh telemetry root span.
    const message: VideoRenderMessage = {
        _version: VIDEO_RENDER_MESSAGE_VERSION,
        apiKeyId,
        body,
        enqueuedAt: Date.now(),
        isByok,
        jobId,
        modelInfo: {
            costPerSecondMicrodollars: modelInfo.costPerSecondMicrodollars,
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
        await c.env.VIDEO_RENDER_QUEUE.send(message);
    } catch (error) {
        // If we can't enqueue, the job will be orphaned in `pending`. Surface
        // the failure to the caller so they can retry the POST, and mark the
        // job failed so the GET endpoint doesn't return stale `pending`.
        // Also drop the stashed render secret — it can't be used now.
        console.error("[video] failed to enqueue render:", error);

        await putJob(c.env.RATE_LIMIT_KV, { ...job, completedAt: Date.now(), errorMessage: "Failed to enqueue render job", status: "failed" }).catch(() => {});
        await c.env.CACHE_KV.delete(videoRenderSecretKvKey(jobId)).catch(() => {});

        return c.json(
            {
                error: {
                    code: "QUEUE_ENQUEUE_FAILED",
                    message: "Failed to enqueue video render job. Please retry.",
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
    error?: string;
    generation_id: string;
    id: string;
    model: string;
    polling_url: string;
    status: string;
    unsigned_urls?: string[];
    usage?: { cost: string; is_byok: boolean };
}

// ─── GET /v1/videos/:jobId ─────────────────────────────────────────────────────

videoRouter.get("/v1/videos/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const userId = c.get("userId");
    let job = await getJob(c.env.RATE_LIMIT_KV, jobId);

    if (!job || job.userId !== userId) {
        return c.json({ error: `Video generation job '${jobId}' not found` }, 404);
    }

    // Stall recovery: defensive net for the case where a consumer invocation
    // hit a runtime limit AND the queue retry/DLQ chain also lost the job.
    // With queues this should be vanishingly rare.
    if (job.status === "in_progress" && job.startedAt && Date.now() - job.startedAt > RENDER_STALL_THRESHOLD_MS) {
        const failed: VideoJobState = {
            ...job,
            completedAt: Date.now(),
            errorMessage: "Render stalled and was reaped after exceeding the stall threshold.",
            status: "failed",
        };

        await putJob(c.env.RATE_LIMIT_KV, failed).catch(() => {});
        await c.env.USAGE_DB.prepare(
            `UPDATE video_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ? AND status = 'in_progress'`,
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
        response.unsigned_urls = [buildContentUrl(origin, jobId, 0)];
        response.usage = {
            cost: ((job.costMicrodollars ?? 0) / 1_000_000).toFixed(6),
            is_byok: job.isByok ?? false,
        };
    }

    if (job.status === "failed") {
        response.error = job.errorMessage ?? "Generation failed";
    }

    return c.json(response);
});

// ─── GET /v1/videos/:jobId/content ─────────────────────────────────────────────

videoRouter.get("/v1/videos/:jobId/content", async (c) => {
    const jobId = c.req.param("jobId");
    const userId = c.get("userId");
    const indexParameter = c.req.query("index") ?? "0";
    const index = indexParameter.trim().length > 0 ? Math.trunc(Number(indexParameter)) : NaN;

    if (Number.isNaN(index) || index < 0) {
        return c.json({ error: "index must be a non-negative integer" }, 400);
    }

    // Today every job has exactly one output (index=0). Reject other indices
    // explicitly so callers don't silently fall through to "not found".
    if (index !== 0) {
        return c.json({ error: `Output index ${index} not available — this job produced 1 video.` }, 404);
    }

    const job = await getJob(c.env.RATE_LIMIT_KV, jobId);

    if (!job || job.userId !== userId) {
        return c.json({ error: `Video generation job '${jobId}' not found` }, 404);
    }

    if (job.status !== "completed" || !job.r2Key) {
        return c.json({ error: `Job is ${job.status}; content not available yet` }, 409);
    }

    const object = await c.env.VIDEO_BUCKET.get(job.r2Key);

    if (!object) {
        return c.json({ error: "Rendered video has expired or been deleted" }, 410);
    }

    return new Response(object.body, {
        headers: {
            "Cache-Control": "private, max-age=3600",
            "Content-Length": String(object.size),
            "Content-Type": object.httpMetadata?.contentType ?? job.mimeType ?? "video/mp4",
        },
    });
});

// ─── GET /v1/videos/models ─────────────────────────────────────────────────────

videoRouter.get("/v1/videos/models", (c) => {
    const data = Object.values(VIDEO_MODELS).map((info) => {
        return {
            allowed_passthrough_parameters: info.allowedPassthroughParameters,
            canonical_slug: info.canonicalSlug,
            created: info.created,
            description: info.description,
            id: info.canonicalSlug,
            name: info.name,
            pricing_skus: info.pricingSkus,
            supported_aspect_ratios: info.supportedAspectRatios,
            supported_resolutions: info.supportedResolutions,
            supported_sizes: info.supportedSizes,
        };
    });

    return c.json({ data });
});

export { videoRouter };
