/**
 * Pure render-core for video generation jobs.
 *
 * Originally lived in `video.ts` as a `waitUntil`-spawned coroutine attached
 * to the HTTP request lifecycle. That meant the render raced the request's
 * CPU/wall-clock budget and any telemetry/usage written after the response
 * returned was silently dropped (the request's telemetry middleware had
 * already flushed).
 *
 * Now the producer POST handler enqueues a {@link VideoRenderMessage} into
 * `VIDEO_RENDER_QUEUE` and this module's `runVideoRender` is invoked from
 * the Worker's `queue()` handler, which gets its own invocation lifecycle.
 *
 * No Hono context: this module takes `env` and `RequestTelemetry` directly.
 */
import { experimental_generateVideo } from "ai";

import type { AppEnv } from "../../env.js";
import type { RequestTelemetry } from "../../lib/otel/index.js";
import { createVideoModel } from "../../providers/video-factory.js";
import { UsageTracker } from "../../usage/tracker.js";
import type { VideoRenderMessage } from "./video-types.js";
import { videoRenderSecretKvKey } from "./video-types.js";

// ─── Job state (KV — small, fast, eventually consistent) ────────────────────────

export type JobStatus = "pending" | "in_progress" | "completed" | "failed";

export interface VideoJobState {
    callbackUrl?: string;
    completedAt?: number;
    costMicrodollars?: number;
    createdAt: number;
    durationSeconds?: number;
    errorMessage?: string;
    id: string;
    isByok?: boolean;
    mimeType?: string;
    modelApiId: string;
    modelId: string; // canonical (e.g. "fal/luma-ray-2")
    orgId?: string;
    prompt: string;
    provider: string;
    r2Key?: string;
    startedAt?: number;
    status: JobStatus;
    userId: string;
}

export const JOB_TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * If a job has been `in_progress` for longer than this, the consumer that
 * owned it almost certainly hit a CPU/wall-clock limit. Pollers mark such
 * jobs as `failed` so callers don't wait indefinitely. With queue retries
 * this is purely defensive — a re-delivered message would normally clear
 * the stale status itself — but it's cheap and protects against DLQ-and-
 * lost-forever scenarios.
 */
export const RENDER_STALL_THRESHOLD_MS = 10 * 60 * 1000;

export const getJob = async (kv: KVNamespace, jobId: string): Promise<VideoJobState | null> =>
    (await kv.get(`video_job:${jobId}`, "json")) as VideoJobState | null;

export const putJob = async (kv: KVNamespace, job: VideoJobState): Promise<void> => {
    await kv.put(`video_job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
};

// ─── Webhook delivery ──────────────────────────────────────────────────────────

export const buildPollingUrl = (origin: string, jobId: string): string => `${origin}/v1/videos/${jobId}`;
export const buildContentUrl = (origin: string, jobId: string, index = 0): string => `${origin}/v1/videos/${jobId}/content?index=${index}`;

const eventTypeFor = (status: JobStatus): string => {
    switch (status) {
        case "completed": {
            return "video.generation.completed";
        }
        case "failed": {
            return "video.generation.failed";
        }
        default: {
            return `video.generation.${status}`;
        }
    }
};

/** The fields the render webhooks put inside `data`, next to `id` and `status`. */
interface RenderWebhookPayload {
    error?: string;
    generation_id: string;
    model: string;
    polling_url: string;
    unsigned_urls?: string[];
    usage?: { cost: string; is_byok: boolean };
}

export const fireWebhook = async (callbackUrl: string, jobId: string, status: JobStatus, payload: RenderWebhookPayload): Promise<void> => {
    try {
        const body = {
            created_at: new Date().toISOString(),
            data: { id: jobId, status, ...payload },
            type: eventTypeFor(status),
        };

        const response = await fetch(callbackUrl, {
            body: JSON.stringify(body),
            headers: {
                "Content-Type": "application/json",
                "X-OpenRouter-Idempotency-Key": `${jobId}-${status}`,
            },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
        });

        // Nothing reads the reply; cancel it so the Worker releases the connection.
        await response.body?.cancel();

        if (!response.ok) {
            console.warn(`[video] callback ${callbackUrl} returned ${response.status}`);
        }
    } catch (error) {
        console.warn(`[video] callback delivery failed:`, error);
    }
};

// ─── Render core ───────────────────────────────────────────────────────────────

/**
 * Returned by {@link runVideoRender} so the consumer can decide
 * ack-vs-retry based on a structured outcome (rather than catching
 * raw errors).
 */
export type RenderOutcome =
    | { costMicrodollars: number; kind: "completed"; latencyMs: number }
    | { kind: "skipped"; reason: "already-completed" }
    | { errorMessage: string; kind: "failed"; retryable: boolean };

/**
 * Persist terminal failure for a job: write `failed` to KV + D1 and fire the
 * webhook (if a callback URL was registered). Idempotent — calling twice on
 * an already-terminal job is a no-op, so it's safe to invoke from both the
 * render core (terminal exceptions) and the consumer (transient retries
 * exhausted) without coordinating between them.
 */
export const markRenderFailed = async (env: AppEnv, message: VideoRenderMessage, errorMessage: string): Promise<void> => {
    const existing = await getJob(env.RATE_LIMIT_KV, message.jobId);

    if (existing?.status === "completed" || existing?.status === "failed") {
        return;
    }

    const failedJob: VideoJobState = {
        callbackUrl: message.body.callback_url,
        completedAt: Date.now(),
        createdAt: existing?.createdAt ?? message.enqueuedAt,
        errorMessage,
        id: message.jobId,
        isByok: message.isByok,
        modelApiId: message.modelInfo.modelApiId,
        modelId: message.body.model,
        orgId: message.orgId,
        prompt: message.body.prompt,
        provider: message.modelInfo.provider,
        startedAt: existing?.startedAt,
        status: "failed",
        userId: message.userId,
    };

    await putJob(env.RATE_LIMIT_KV, failedJob).catch(() => {});
    await env.USAGE_DB.prepare(
        `UPDATE video_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ? AND status != 'completed'`,
    )
        .bind(errorMessage, message.jobId)
        .run()
        .catch(() => {});

    // Best-effort cleanup of the API-key indirection record. TTL is the real
    // safety net (see VIDEO_RENDER_SECRET_TTL_SECONDS); this just shortens
    // the exposure window when we know we're done with the job.
    await env.CACHE_KV.delete(videoRenderSecretKvKey(message.jobId)).catch(() => {});

    if (message.body.callback_url) {
        await fireWebhook(message.body.callback_url, message.jobId, "failed", {
            error: errorMessage,
            generation_id: message.jobId,
            model: message.body.model,
            polling_url: buildPollingUrl(message.origin, message.jobId),
        });
    }
};

/**
 * Render a single video job. Idempotent: if the job has already reached
 * `completed`, this is a no-op (returns `{ kind: "skipped" }`) so a re-
 * delivered queue message doesn't double-charge or double-fire webhooks.
 *
 * Caller is responsible for telemetry span lifecycle around this call.
 */
export const runVideoRender = async (message: VideoRenderMessage, env: AppEnv, telemetry?: RequestTelemetry): Promise<RenderOutcome> => {
    const { apiKeyId, body, isByok, jobId, modelInfo, orgId, origin, requestId, userId } = message;
    const startTime = Date.now();

    // Idempotency guard: if a prior attempt already completed (or the job
    // was force-failed by the stall reaper), don't redo work.
    const existing = await getJob(env.RATE_LIMIT_KV, jobId);

    if (existing?.status === "completed") {
        return { kind: "skipped", reason: "already-completed" };
    }

    if (existing?.status === "failed") {
        // Already terminally failed (e.g. via stall reaper). Don't resurrect.
        return { kind: "skipped", reason: "already-completed" };
    }

    // Pull the resolved provider API key from KV (producer stashed it there
    // under the same jobId so it never had to live in the queue message).
    const apiKey = await env.CACHE_KV.get(videoRenderSecretKvKey(jobId));

    if (!apiKey) {
        // KV TTL expired before this delivery, or the producer's PUT failed.
        // Either way, no recovery — mark failed and don't retry.
        const errorMessage = "Provider API key reference expired before render";

        await markRenderFailed(env, message, errorMessage);

        return { errorMessage, kind: "failed", retryable: false };
    }

    // Mark in_progress + record start time for stall detection.
    const inProgressJob: VideoJobState = {
        callbackUrl: body.callback_url,
        createdAt: existing?.createdAt ?? message.enqueuedAt,
        id: jobId,
        isByok,
        modelApiId: modelInfo.modelApiId,
        modelId: body.model,
        orgId,
        prompt: body.prompt,
        provider: modelInfo.provider,
        startedAt: Date.now(),
        status: "in_progress",
        userId,
    };

    await putJob(env.RATE_LIMIT_KV, inProgressJob);
    await env.USAGE_DB.prepare(`UPDATE video_jobs SET status = 'in_progress', started_at = datetime('now') WHERE id = ?`)
        .bind(jobId)
        .run()
        .catch(() => {});

    try {
        const model = await createVideoModel(modelInfo.provider, modelInfo.modelApiId, apiKey);

        const result = await experimental_generateVideo({
            model,
            prompt: body.prompt,
            ...(body.duration !== undefined && { duration: body.duration }),
            ...(body.aspect_ratio !== undefined && { aspectRatio: body.aspect_ratio as `${number}:${number}` }),
            ...(body.resolution !== undefined && { resolution: body.resolution as `${number}x${number}` }),
            ...(body.seed !== undefined && { seed: body.seed }),
        });

        const latencyMs = Date.now() - startTime;
        const { video } = result;
        const r2Key = `videos/${userId}/${jobId}.mp4`;

        // Upload bytes to R2 (uint8Array, NOT base64 — keep memory bounded)
        await env.VIDEO_BUCKET.put(r2Key, video.uint8Array, {
            customMetadata: { jobId, modelId: body.model, userId },
            httpMetadata: { contentType: video.mediaType },
        });

        const durationSeconds = body.duration ?? 5;
        const costMicrodollars = isByok ? 0 : Math.round(durationSeconds * modelInfo.costPerSecondMicrodollars);

        const completedJob: VideoJobState = {
            ...inProgressJob,
            completedAt: Date.now(),
            costMicrodollars,
            durationSeconds,
            mimeType: video.mediaType,
            r2Key,
            status: "completed",
        };

        await putJob(env.RATE_LIMIT_KV, completedJob);

        await env.USAGE_DB.prepare(
            `UPDATE video_jobs SET status = 'completed', r2_key = ?, mime_type = ?, duration_seconds = ?, cost_microdollars = ?, latency_ms = ?, completed_at = datetime('now') WHERE id = ?`,
        )
            .bind(r2Key, video.mediaType, durationSeconds, costMicrodollars, latencyMs, jobId)
            .run()
            .catch((error) => console.error("[video] failed to update video_job:", error));

        const usageTracker = new UsageTracker(env);

        await usageTracker
            .record(
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
                    promptTokens: Math.round(durationSeconds),
                    provider: modelInfo.provider,
                    reasoningTokens: 0,
                    requestId,
                    source: "saas_api",
                    userId,
                },
                telemetry,
            )
            .catch((error) => console.error("[video] failed to record usage:", error));

        if (body.callback_url) {
            await fireWebhook(body.callback_url, jobId, "completed", {
                generation_id: jobId,
                model: body.model,
                polling_url: buildPollingUrl(origin, jobId),
                unsigned_urls: [buildContentUrl(origin, jobId, 0)],
                usage: { cost: (costMicrodollars / 1_000_000).toFixed(6), is_byok: isByok },
            });
        }

        // Job is terminal — release the API-key indirection record early
        // instead of waiting for its TTL to expire.
        await env.CACHE_KV.delete(videoRenderSecretKvKey(jobId)).catch(() => {});

        return { costMicrodollars, kind: "completed", latencyMs };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Decide retryability up front so the consumer can react accordingly.
        // Transient: network, abort, 5xx. Terminal: validation, auth, model-not-found.
        const isRetryable = isTransient(error);

        // Non-retryable failures are terminal at this attempt — persist failed
        // state now. Transient failures leave the row as `in_progress` so a
        // queue retry can resume; the consumer is responsible for finalising
        // failure when the retry budget runs out (see `markRenderFailed`
        // call in queue/video-render-consumer.ts).
        if (!isRetryable) {
            await markRenderFailed(env, message, errorMessage);
        }

        return { errorMessage, kind: "failed", retryable: isRetryable };
    }
};

/**
 * Heuristic: which errors are worth retrying via the queue?
 *
 * - Network/abort/timeout from `fetch` → transient.
 * - HTTP 5xx from the provider → transient.
 * - Validation, auth, model-not-found, prompt-too-long → terminal.
 *
 * The AI SDK throws structured errors but the shape varies by provider, so
 * we fall back to message-substring matching for the common cases.
 */
/** DOM/fetch error names that map to a retryable network condition. */
const TRANSIENT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "TypeError"]);

/** Retryable HTTP status codes as they surface inside provider error messages. */
const TRANSIENT_STATUS_IN_MESSAGE_RE = /\b(?:500|502|503|504|429)\b/;

const isTransient = (error: unknown): boolean => {
    if (!error) return false;

    if (error instanceof Error) {
        // Standard DOM / fetch errors that map to transient network issues
        if (TRANSIENT_ERROR_NAMES.has(error.name)) {
            return true;
        }

        const message = error.message.toLowerCase();

        // Provider HTTP 5xx surfaces as "... 500", "... 502 Bad Gateway", etc.
        if (TRANSIENT_STATUS_IN_MESSAGE_RE.test(message)) return true;

        if (message.includes("econnreset") || message.includes("etimedout") || message.includes("network")) return true;
    }

    // Some AI SDK errors carry a numeric statusCode property
    const status = (error as { status?: number; statusCode?: number }).statusCode ?? (error as { status?: number; statusCode?: number }).status;

    return typeof status === "number" && (status >= 500 || status === 429);
};
