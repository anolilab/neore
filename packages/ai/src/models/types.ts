import type { Experimental_VideoModelV4, ImageModelV4, SpeechModelV4, TranscriptionModelV4 } from "@ai-sdk/provider";
import type { EmbeddingModel, LanguageModel, LanguageModelRequestMetadata, LanguageModelResponseMetadata, LanguageModelUsage, ToolSet } from "ai";

export type ProviderKind =
    "groq" | "openai" | "xai" | "openrouter" | "requesty" | "fal" | "google" | "klingai" | "luma" | "replicate" | "fireworks" | "bfl" | "external";

/**
 * Options to determine what messages are included as context in message generation.
 * Mirrors the agent validators in `backend/lunora/agent`; kept separate to avoid a circular dependency.
 */
export interface ContextOptions {
    /**
     * Whether to include recent messages for text search.
     */
    includeToolMessages?: boolean;

    /**
     * Range of messages around the target to include as context.
     */
    messageRange?: { after: number; before: number };

    /**
     * Number of messages to include from the current thread.
     * Set to 0 to include none, or undefined to include default (10).
     */
    recentMessages?: number;

    /**
     * The number of similar messages to include from vector search.
     */
    searchLimit?: number;

    /**
     * Whether to search for similar messages based on the query.
     * Only works with an embedding model configured.
     */
    searchOtherThreads?: boolean;
}

/**
 * Options for storing messages and embeddings.
 * Mirrors the agent validators in `backend/lunora/agent`; kept separate to avoid a circular dependency.
 */
export interface StorageOptions {
    /**
     * Whether to save messages to the database.
     */
    saveMessages?: boolean;

    /**
     * Skip generating embeddings for messages.
     */
    skipEmbeddings?: boolean;
}

/**
 * Handler for usage tracking.
 * Mirrors the agent validators in `backend/lunora/agent`; kept separate to avoid a circular dependency.
 */
export type UsageHandler = (
    context: unknown,
    args: {
        agentName: string | undefined;
        model: string | undefined;
        provider: string | undefined;
        threadId: string | undefined;
        usage: LanguageModelUsage;
        userId: string | undefined;
    },
) => void | Promise<void>;

type RawRequestResponseHandler = (
    context: unknown,
    arguments_: {
        agentName: string | undefined;
        request: LanguageModelRequestMetadata;
        response: LanguageModelResponseMetadata;
        threadId: string | undefined;
        userId: string | undefined;
    },
) => void | Promise<void>;

/**
 * Single source-of-truth definition for a model.
 * To add or modify a model, edit models/registry.ts only.
 */
export interface ModelDefinition {
    // ── Image / video generation ──────────────────────────────────
    aspectRatios?: ReadonlyArray<string>;
    avgLatencyMs?: number;
    /** Character reference modes (e.g., ["face", "style", "composition"]) */
    characterRefModes?: ReadonlyArray<string>;

    // ── Agent execution config (text models only) ─────────────────
    contextOptions?: ContextOptions;
    /** ControlNet control types supported (e.g., ["pose", "depth", "canny"]) */
    controlNetTypes?: ReadonlyArray<string>;
    /** Image billing — cost per generated image in microdollars. */
    costPerImageMicrodollars?: number;

    /**
     * Music billing — cost per generation in microdollars. FAL music models bill
     * per-call (not per-second), and clip lengths are fixed/bounded by the
     * model (Stable Audio 2.5 ≤ 190s, MusicGen ≤ 30s, etc.) so a single
     * per-generation rate is a closer match than the video per-second model.
     */
    costPerMusicGenerationMicrodollars?: number;

    /** Video billing — cost per second of generated video in microdollars. */
    costPerSecondMicrodollars?: number;

    /**
     * Speech billing — cost per 1,000 input characters in microdollars. A
     * `text-to-speech` model with it is served by the gateway's
     * `/internal/speech` (`GATEWAY_SPEECH_MODELS`).
     */
    costPerThousandCharsMicrodollars?: number;
    defaultEnabledFeatures?: string[];
    defaultReasoningEffort?: number;
    /** Short description shown on marketing pages */
    desc?: string;

    /** Human-readable provider name for display (e.g., "Anthropic") */
    displayProvider?: string;

    // ── UI metadata ───────────────────────────────────────────────
    enabled?: boolean;

    /**
     * PostHog feature flag that must be enabled for this model to appear in the
     * model picker. When set, the model is included in the gateway catalog but hidden
     * from the UI unless the flag is active for the current user.
     */
    featureFlag?: string;
    filterCapabilities?: string[];

    /**
     * Whitelist of provider-specific parameters that may be passed via
     * `provider.options.{slug}.parameters` on `/v1/videos` requests.
     */
    gatewayAllowedPassthrough?: ReadonlyArray<string>;
    /** Unix epoch (seconds) — when the model was first added to the gateway. */
    gatewayCreated?: number;
    /** Public-facing description for the gateway catalog; falls back to `desc`. */
    gatewayDescription?: string;
    /** Estimated render time in seconds; UX hint, not exposed in the API. */
    gatewayEstimatedLatencySeconds?: number;
    // ── Gateway exposure (services/llm-gateway public API) ────────

    /**
     * Public model identifier exposed via `GET /v1/images/models` and `GET /v1/videos/models`.
     * Presence opts this model into the gateway's public catalog and is used as the
     * `model` field clients pass to `POST /v1/images` / `POST /v1/videos`.
     *
     * Image keys are typically short slugs (e.g. "flux-schnell"). Video keys follow
     * the OpenRouter `provider/name` form (e.g. "fal/luma-dream-machine").
     */
    gatewayKey?: string;

    /**
     * Override `modelApiId` when invoking the provider SDK from the gateway worker.
     * Falls back to `modelApiId`. Useful when the SDK expects a short form
     * (e.g. fal video models accept "luma-dream-machine", not "fal-ai/luma-dream-machine").
     */
    gatewayModelApiId?: string;

    /**
     * OpenRouter-aligned pricing SKU strings (dollars per unit, string-encoded).
     * Surfaced verbatim by `GET /v1/videos/models`.
     */
    gatewayPricingSkus?: {
        "per-video"?: string;
        "per-video-second"?: string;
        "per-video-second-1080p"?: string;
    };
    /** Resolution buckets (e.g. "720p", "1080p") published by `/v1/videos/models`. */
    gatewaySupportedResolutions?: ReadonlyArray<string>;
    /** Explicit pixel sizes (e.g. "1280x720") published by `/v1/videos/models`. */
    gatewaySupportedSizes?: ReadonlyArray<string>;
    // ── Identity ─────────────────────────────────────────────────
    /** Internal key used everywhere (e.g. "kimi-k2-instruct") */
    id: string;

    instructions?: string;
    isNew?: boolean;
    isPremium?: boolean;
    /** Whether this is a preprocessor model (pose detection, depth estimation, etc.) */
    isPreprocessor?: boolean;
    legacy?: boolean;

    /**
     * Show this model on marketing pages (footer, /models route, landing page).
     * External models (provider: "external") are listed-only and have no API.
     * Setting enabled: false also hides listed models from the catalog.
     */
    listed?: boolean;
    maxDuration?: number;
    /** Music — longest clip the model can produce, in seconds. */
    maxMusicDurationSeconds?: number;
    maxReasoningEffort?: number;
    /** Max number of reference images */
    maxReferenceImages?: number;
    maxResolution?: string;
    maxRetries?: number;
    maxSteps?: number;
    /** Maximum video duration in seconds */
    maxVideoDuration?: number;

    // ── Mode (omit = text) ────────────────────────────────────────
    mode?: "text" | "image" | "video" | "music" | "speech-to-text" | "text-to-speech";
    /** Actual ID passed to provider factory (may equal id) */
    modelApiId: string;
    /** Override display name (used when model has no registry entry) */
    name?: string;
    /** Preprocessor type (openpose, depth, canny, normal, softedge) */
    preprocessorType?: string;

    provider: ProviderKind;
    // ── Registry lookup ────────────────────────────────────────────
    /** Override lookup key in external registries if different from id */
    registryId?: string;
    // ── Marketing display (listed models only) ────────────────────
    /** URL slug used on marketing pages and in SEO (e.g., "claude-haiku-4-5") */
    slug?: string;
    /** Style reference strength range [min, max] */
    styleRefStrengthRange?: readonly [number, number];

    /** Music — output audio formats (e.g. ["mp3", "wav"]). */
    supportedAudioFormats?: ReadonlyArray<string>;
    /** Supported video FPS options */
    supportedFps?: ReadonlyArray<number>;

    /** Override default MIME list */
    supportedMimeTypes?: string[];
    /** Music — supported sample rates (e.g. [44_100, 48_000]). */
    supportedSampleRates?: ReadonlyArray<number>;
    /** Supports background removal */
    supportsBackgroundRemoval?: boolean;
    /** Supports character/subject reference (IP-Adapter) */
    supportsCharacterRef?: boolean;
    // ── ControlNet capabilities ───────────────────────────────────────
    /** Supports ControlNet conditioning */
    supportsControlNet?: boolean;
    /** Supports face enhancement in upscaling */
    supportsFaceEnhance?: boolean;

    /** Accepts file attachments */
    supportsFileInput?: boolean;
    // ── Capabilities ─────────────────────────────────────────────
    /** Accepts image input */
    supportsImages?: boolean;
    /** Supports image-to-video animation */
    supportsImageToVideo?: boolean;
    // ── Image transformation capabilities ──────────────────────────
    /** Supports image-to-image transformation */
    supportsImg2Img?: boolean;
    /** Supports inpainting (masked region editing) */
    supportsInpaint?: boolean;
    supportsNegativePrompt?: boolean;
    /** Supports object removal/inpainting */
    supportsObjectRemoval?: boolean;
    /** Supports outpainting (canvas expansion) */
    supportsOutpaint?: boolean;
    /** Supports style reference/transfer */
    supportsStyleRef?: boolean;
    /** Supports style weight fine-tuning */
    supportsStyleWeight?: boolean;
    // ── Video capabilities ───────────────────────────────────────────
    /** Supports text-to-video generation */
    supportsTextToVideo?: boolean;
    /** Default true; false = cannot use tools */
    supportsToolCalling?: boolean;
    /** Supports image upscaling */
    supportsUpscale?: boolean;
    /** Quality tier for marketing display */
    tier?: "budget" | "fast" | "frontier" | "high-quality" | "medium";
    /** Speech: the voice used when the caller names none (or one not in `ttsVoices`). */
    ttsDefaultVoice?: string;
    /** Speech: the preset voice ids the model accepts. */
    ttsVoices?: ReadonlyArray<string>;
    /** Available upscale factors (e.g., [2, 4]) */
    upscaleFactors?: ReadonlyArray<number>;
}

/**
 * Agent configuration structure used by the agent loop.
 * For text models, `chat` is set. For FAL image models, `imageModel` is set.
 * For FAL video models, `videoModel` is set.
 */
export interface AgentConfig {
    /**
     * The LLM model to use for generating / streaming text and objects.
     * Undefined for image/video (FAL) models.
     */
    chat?: LanguageModel;

    /**
     * Options to determine what messages are included as context in message generation.
     */
    contextOptions?: ContextOptions;

    /**
     * The image generation model.
     * Set for models with mode === "image" (fal, openai, xai, google, luma, replicate, fireworks, bfl).
     */
    imageModel?: ImageModelV4;

    /**
     * The default system prompt to put in each request.
     */
    instructions?: string;

    /**
     * The maximum number of calls to make to an LLM in case it fails.
     */
    maxRetries?: number;

    /**
     * When generating or streaming text with tools available, this
     * determines the default max number of iterations.
     */
    maxSteps?: number;

    /**
     * The name for the agent.
     */
    name?: string;

    /**
     * Called for each LLM request/response.
     */
    rawRequestResponseHandler?: RawRequestResponseHandler;

    /**
     * The text-to-speech model (FAL speech models).
     * Set for models where provider === "fal" and mode === "text-to-speech".
     */
    speechModel?: SpeechModelV4;

    /**
     * Determines whether messages are automatically stored.
     */
    storageOptions?: StorageOptions;

    /**
     * The model to use for text embeddings. Optional.
     */
    textEmbedding?: EmbeddingModel;

    /**
     * Tools that the agent can call out to.
     */
    tools?: ToolSet;

    /**
     * The speech-to-text transcription model (FAL transcription models).
     * Set for models where provider === "fal" and mode === "speech-to-text".
     */
    transcriptionModel?: TranscriptionModelV4;

    /**
     * The usage handler to use for this agent.
     */
    usageHandler?: UsageHandler;

    /**
     * The video generation model.
     * Set for models with mode === "video" (fal, klingai, replicate).
     */
    videoModel?: Experimental_VideoModelV4;
}
