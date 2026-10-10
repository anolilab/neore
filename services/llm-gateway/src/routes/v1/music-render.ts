/**
 * Pure render-core for music generation jobs.
 *
 * Mirrors `video-render.ts` (see that module for the architectural rationale
 * — same producer/consumer split, same idempotency model, same KV API-key
 * indirection). The differences are music-specific:
 *
 *   - No AI SDK V3 primitive for music: we call FAL via the queue submit/
 *     poll HTTP flow in {@link runFalMusicGeneration}.
 *   - Pricing is flat per-generation, not per-second.
 *   - Output blobs land in `MUSIC_BUCKET` under `music/{userId}/{jobId}.wav`.
 *
 * The render core decides retryability via {@link isTransient}; the consumer
 * (`queue/music-render-consumer.ts`) reads {@link RenderOutcome} and chooses
 * ack-vs-retry from there. Transient failures leave the job `in_progress`
 * for a queue retry to resume; the consumer finalises terminal state when
 * the retry budget runs out via {@link markRenderFailed}.
 */
import type { JSONObject, JSONValue } from "@ai-sdk/provider";

import type { AppEnv } from "../../env.js";
import { GatewayError } from "../../lib/errors.js";
import type { RequestTelemetry } from "../../lib/otel/index.js";
import { MUSIC_MODELS, runFalMusicGeneration } from "../../providers/music-factory.js";
import { UsageTracker } from "../../usage/tracker.js";
import type { MusicRenderMessage } from "./music-types.js";
import { musicRenderSecretKvKey } from "./music-types.js";

// ─── Job state (KV — small, fast, eventually consistent) ────────────────────────

export type JobStatus = "pending" | "in_progress" | "completed" | "failed";

export interface MusicJobState {
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
    modelId: string;
    orgId?: string;
    prompt: string;
    provider: string;
    r2Key?: string;
    sampleRate?: number;
    startedAt?: number;
    status: JobStatus;
    userId: string;
}

export const JOB_TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * Music renders typically finish in &lt;30s; if a job has been `in_progress`
 * longer than this, the consumer that owned it almost certainly hit a
 * runtime limit. Pollers mark such jobs `failed` so callers don't wait
 * indefinitely. With queue retries this is purely defensive.
 */
export const RENDER_STALL_THRESHOLD_MS = 5 * 60 * 1000;

export const getJob = async (kv: KVNamespace, jobId: string): Promise<MusicJobState | null> =>
    (await kv.get(`music_job:${jobId}`, "json")) as MusicJobState | null;

export const putJob = async (kv: KVNamespace, job: MusicJobState): Promise<void> => {
    await kv.put(`music_job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
};

// ─── Webhook delivery ──────────────────────────────────────────────────────────

export const buildPollingUrl = (origin: string, jobId: string): string => `${origin}/v1/music/${jobId}`;
export const buildContentUrl = (origin: string, jobId: string): string => `${origin}/v1/music/${jobId}/content`;

const eventTypeFor = (status: JobStatus): string => {
    switch (status) {
        case "completed": {
            return "music.generation.completed";
        }
        case "failed": {
            return "music.generation.failed";
        }
        default: {
            return `music.generation.${status}`;
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
            console.warn(`[music] callback ${callbackUrl} returned ${response.status}`);
        }
    } catch (error) {
        console.warn(`[music] callback delivery failed:`, error);
    }
};

// ─── Render core ───────────────────────────────────────────────────────────────

export type RenderOutcome =
    | { costMicrodollars: number; kind: "completed"; latencyMs: number }
    | { kind: "skipped"; reason: "already-completed" }
    | { errorMessage: string; kind: "failed"; retryable: boolean };

/**
 * Persist terminal failure for a job. Idempotent — no-ops on rows that are
 * already `completed`/`failed`, so it's safe to invoke from both the render
 * core (terminal exceptions) and the consumer (transient retries exhausted)
 * without coordinating between them.
 */
export const markRenderFailed = async (env: AppEnv, message: MusicRenderMessage, errorMessage: string): Promise<void> => {
    const existing = await getJob(env.RATE_LIMIT_KV, message.jobId);

    if (existing?.status === "completed" || existing?.status === "failed") {
        return;
    }

    const failedJob: MusicJobState = {
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
        `UPDATE music_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ? AND status != 'completed'`,
    )
        .bind(errorMessage, message.jobId)
        .run()
        .catch(() => {});

    await env.CACHE_KV.delete(musicRenderSecretKvKey(message.jobId)).catch(() => {});

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
 * Build the FAL inputs object for a music generation. Honours the
 * registry's `allowedPassthroughParameters` whitelist so callers can't
 * inject arbitrary provider-specific fields (only the model definition
 * decides which extras flow through).
 */
const buildFalInputs = (body: MusicRenderMessage["body"], allowedPassthrough: ReadonlyArray<string>): JSONObject => {
    const inputs: JSONObject = { prompt: body.prompt };

    if (body.negative_prompt !== undefined) inputs.negative_prompt = body.negative_prompt;

    if (body.duration !== undefined) inputs.seconds_total = body.duration;

    if (body.seed !== undefined) inputs.seed = body.seed;

    const providerParams = body.provider?.options?.fal?.parameters;

    if (providerParams) {
        for (const key of allowedPassthrough) {
            const value = providerParams[key];

            // The whitelisted value came out of a JSON request body, so it is JSON.
            if (value !== undefined) inputs[key] = value as JSONValue;
        }
    }

    return inputs;
};

/**
 * Render a single music job. Idempotent: completed/failed jobs are
 * no-ops so a re-delivered queue message doesn't double-charge or
 * double-fire webhooks.
 */
export const runMusicRender = async (message: MusicRenderMessage, env: AppEnv, telemetry?: RequestTelemetry): Promise<RenderOutcome> => {
    const { apiKeyId, body, isByok, jobId, modelInfo, orgId, origin, requestId, userId } = message;
    const startTime = Date.now();

    const existing = await getJob(env.RATE_LIMIT_KV, jobId);

    if (existing?.status === "completed" || existing?.status === "failed") {
        return { kind: "skipped", reason: "already-completed" };
    }

    const apiKey = await env.CACHE_KV.get(musicRenderSecretKvKey(jobId));

    if (!apiKey) {
        const errorMessage = "Provider API key reference expired before render";

        await markRenderFailed(env, message, errorMessage);

        return { errorMessage, kind: "failed", retryable: false };
    }

    const inProgressJob: MusicJobState = {
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
    await env.USAGE_DB.prepare(`UPDATE music_jobs SET status = 'in_progress', started_at = datetime('now') WHERE id = ?`)
        .bind(jobId)
        .run()
        .catch(() => {});

    try {
        // Passthrough whitelist comes from the registry (single source of truth)
        // rather than the message envelope — that way a registry change rolls
        // out without re-versioning the queue schema.
        const allowedPassthrough = MUSIC_MODELS[body.model]?.allowedPassthroughParameters ?? [];
        const inputs = buildFalInputs(body, allowedPassthrough);

        const result = await runFalMusicGeneration(modelInfo.modelApiId, apiKey, inputs);

        const latencyMs = Date.now() - startTime;
        const extension = result.mimeType.includes("mpeg") || result.mimeType.includes("mp3") ? "mp3" : "wav";
        const r2Key = `music/${userId}/${jobId}.${extension}`;

        await env.MUSIC_BUCKET.put(r2Key, result.bytes, {
            customMetadata: { jobId, modelId: body.model, userId },
            httpMetadata: { contentType: result.mimeType },
        });

        const costMicrodollars = isByok ? 0 : modelInfo.costPerMusicGenerationMicrodollars;

        const completedJob: MusicJobState = {
            ...inProgressJob,
            completedAt: Date.now(),
            costMicrodollars,
            durationSeconds: body.duration,
            mimeType: result.mimeType,
            r2Key,
            sampleRate: result.sampleRate,
            status: "completed",
        };

        await putJob(env.RATE_LIMIT_KV, completedJob);

        await env.USAGE_DB.prepare(
            `UPDATE music_jobs SET status = 'completed', r2_key = ?, mime_type = ?, sample_rate = ?, cost_microdollars = ?, latency_ms = ?, completed_at = datetime('now') WHERE id = ?`,
        )
            .bind(r2Key, result.mimeType, result.sampleRate ?? null, costMicrodollars, latencyMs, jobId)
            .run()
            .catch((error) => console.error("[music] failed to update music_job:", error));

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
                    // Music has no token semantics — record a single unit so
                    // analytics can count generations without contorting
                    // the usage_log schema.
                    promptTokens: 1,
                    provider: modelInfo.provider,
                    reasoningTokens: 0,
                    requestId,
                    source: "saas_api",
                    userId,
                },
                telemetry,
            )
            .catch((error) => console.error("[music] failed to record usage:", error));

        if (body.callback_url) {
            await fireWebhook(body.callback_url, jobId, "completed", {
                generation_id: jobId,
                model: body.model,
                polling_url: buildPollingUrl(origin, jobId),
                unsigned_urls: [buildContentUrl(origin, jobId)],
                usage: { cost: (costMicrodollars / 1_000_000).toFixed(6), is_byok: isByok },
            });
        }

        await env.CACHE_KV.delete(musicRenderSecretKvKey(jobId)).catch(() => {});

        return { costMicrodollars, kind: "completed", latencyMs };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const isRetryable = isTransient(error);

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
 * - `GatewayError` with statusCode 5xx / 429 → transient.
 * - Validation, auth, model-not-found → terminal.
 */
/** DOM/fetch error names that map to a retryable network condition. */
const TRANSIENT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "TypeError"]);

/** Retryable HTTP status codes as they surface inside provider error messages. */
const TRANSIENT_STATUS_IN_MESSAGE_RE = /\b(?:500|502|503|504|429)\b/;

const isTransient = (error: unknown): boolean => {
    if (!error) return false;

    if (error instanceof GatewayError) {
        const status = error.statusCode;

        if (typeof status === "number" && (status === 429 || status >= 500)) return true;
    }

    if (error instanceof Error) {
        if (TRANSIENT_ERROR_NAMES.has(error.name)) {
            return true;
        }

        const message = error.message.toLowerCase();

        if (TRANSIENT_STATUS_IN_MESSAGE_RE.test(message)) return true;

        if (message.includes("econnreset") || message.includes("etimedout") || message.includes("network")) return true;
    }

    const status = (error as { status?: number; statusCode?: number }).statusCode ?? (error as { status?: number; statusCode?: number }).status;

    return typeof status === "number" && (status >= 500 || status === 429);
};
