/**
 * Shared types for the music render queue.
 *
 * Mirrors the video-render queue (see ./video-types.ts). The producer
 * (POST /v1/music) serialises one of these into `MUSIC_RENDER_QUEUE`; the
 * consumer (`queue()` handler in src/index.ts) dequeues and renders via FAL.
 *
 * Message size budget: Cloudflare Queue messages are capped at 128 KB.
 * Prompts are ≤2 KB by schema, the model-info subset is ~200 B; no binary
 * payload travels through the queue.
 */

/**
 * Versioned envelope so we can evolve the message schema without breaking
 * in-flight messages. Bump this when fields change shape; the consumer
 * rejects mismatched versions in `handleRenderMessage`.
 */
export const MUSIC_RENDER_MESSAGE_VERSION = 1;

/** KV key under `CACHE_KV` that holds the resolved provider API key for a job. */
export const musicRenderSecretKvKey = (jobId: string): string => `music_render_secret:${jobId}`;

/**
 * TTL for the API-key indirection record. Must comfortably outlive the full
 * queue retry chain (initial + maxRetries × retryDelay + processing time);
 * 1 hour is plenty for music (faster than video — typical generation &lt;30s).
 */
export const MUSIC_RENDER_SECRET_TTL_SECONDS = 60 * 60;

export interface MusicRenderMessage {
    _version: typeof MUSIC_RENDER_MESSAGE_VERSION;

    apiKeyId: string | undefined;

    /**
     * The original (validated) request body. Re-validating in the consumer
     * would be redundant — the producer already enforced the schema.
     */
    body: MusicRenderRequestBody;

    /**
     * When the message was enqueued — used for end-to-end render latency.
     *
     * The resolved provider API key is intentionally NOT in the message
     * body. The producer stashes it under {@link musicRenderSecretKvKey}
     * in `CACHE_KV` with a short TTL, and the consumer fetches it at
     * render time. This shrinks the exposure window from queue retention
     * (≤4 days) to KV TTL (1 hour).
     */
    enqueuedAt: number;
    isByok: boolean;
    jobId: string;
    /** Subset of provider config needed at render time. */
    modelInfo: {
        costPerMusicGenerationMicrodollars: number;
        modelApiId: string;
        provider: string;
    };

    orgId: string | undefined;

    /** Request origin (host) for building polling/content URLs in webhooks. */
    origin: string;

    /**
     * W3C `traceparent` header from the originating HTTP request, so the
     * consumer can adopt the same `traceId` and link the render span to
     * the parent server span.
     */
    parentTraceparent: string | undefined;

    requestId: string;

    userId: string;
}

/**
 * Re-declared inline so this module can be imported by the consumer without
 * pulling in the route module (which depends on Hono + Zod).
 */
export interface MusicRenderRequestBody {
    callback_url?: string;
    /** Duration in seconds. Ignored when the model has a fixed clip length (e.g. Lyria 2 at 30s). */
    duration?: number;
    model: string;
    /** Negative prompt — supported on a subset of models (e.g. Lyria 2). */
    negative_prompt?: string;
    prompt: string;

    /**
     * Provider-specific passthrough parameters (whitelisted per registry).
     * Used for MusicGen variant selection, MusicGen sampling params, etc.
     */
    provider?: {
        options?: Record<string, { parameters?: Record<string, unknown> }>;
    };
    seed?: number;
}
