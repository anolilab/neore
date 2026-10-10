/**
 * Shared types for the video render queue.
 *
 * The producer (POST /v1/videos) serialises one of these into the
 * `VIDEO_RENDER_QUEUE`. The consumer (`queue()` handler in src/index.ts)
 * dequeues, renders, and writes the result to R2/D1/KV.
 *
 * Message size budget: Cloudflare Queue messages are capped at 128 KB.
 * We deliberately keep this payload small — prompts are ≤2 KB by schema,
 * the model info subset is ~200 B, and we don't include image references
 * here (those are still in `body.frame_images` / `body.input_references`
 * as URLs, not binary data).
 */

/**
 * Versioned envelope so we can evolve the message schema without breaking
 * in-flight messages. Bump this when fields change shape; the consumer
 * rejects mismatched versions in `handleRenderMessage`.
 */
export const VIDEO_RENDER_MESSAGE_VERSION = 2;

/** KV key under `CACHE_KV` that holds the resolved provider API key for a job. */
export const videoRenderSecretKvKey = (jobId: string): string => `video_render_secret:${jobId}`;

/**
 * TTL for the API-key indirection record. Must comfortably outlive the full
 * queue retry chain (initial + maxRetries × retryDelay + processing time);
 * 2 hours is plenty for a chain that completes in &lt;10 min today.
 */
export const VIDEO_RENDER_SECRET_TTL_SECONDS = 2 * 60 * 60;

export interface VideoRenderMessage {
    _version: typeof VIDEO_RENDER_MESSAGE_VERSION;

    apiKeyId: string | undefined;

    /**
     * The original (validated) request body. Re-validating in the consumer
     * would be redundant — the producer already enforced the schema.
     */
    body: VideoRenderRequestBody;

    /**
     * When the message was enqueued — used for end-to-end render latency.
     *
     * Note: the resolved provider API key is intentionally NOT in the
     * message body. The producer stashes it under
     * {@link videoRenderSecretKvKey} in `CACHE_KV` with a short TTL, and the
     * consumer fetches it at render time. This shrinks the exposure window
     * from queue retention (up to 4 days) to KV TTL (2 hours).
     */
    enqueuedAt: number;
    isByok: boolean;
    jobId: string;
    /** Subset of provider config needed at render time. */
    modelInfo: {
        costPerSecondMicrodollars: number;
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
export interface VideoRenderRequestBody {
    aspect_ratio?: string;
    callback_url?: string;
    duration?: number;
    frame_images?: { frame_type: "first_frame" | "last_frame"; image_url: { url: string }; type: "image_url" }[];
    generate_audio?: boolean;
    input_references?: { image_url: { url: string }; type: "image_url" }[];
    model: string;
    prompt: string;
    provider?: {
        options?: Record<string, { parameters?: Record<string, unknown> }>;
    };
    resolution?: string;
    seed?: number;
    size?: string;
}
