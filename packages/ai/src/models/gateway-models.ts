/**
 * Gateway model derivation — single source of truth for the LLM gateway's
 * public `/v1/images/models` and `/v1/videos/models` catalogs.
 *
 * Any `ModelDefinition` with a `gatewayKey` is exposed by the gateway.
 * Pricing/SKU metadata lives on the registry entry — the gateway worker imports
 * the derived maps and avoids duplicating model data.
 */
import { MODEL_REGISTRY } from "./registry";

/** Image-model fields the gateway worker needs. */
export interface GatewayImageModelInfo {
    /** Cost per generated image in microdollars. */
    costPerImageMicrodollars: number;

    /**
     * Maximum number of reference images this model accepts.
     * 0/undefined means the model does not support reference images and any
     * `reference_images` field on the request should be ignored.
     * The gateway enforces this cap before mapping into provider options.
     */
    maxReferenceImages?: number;
    modelApiId: string;
    provider: "bfl" | "fal" | "openai";
}

/** OpenRouter-aligned video pricing. Strings are dollars-per-unit. */
export interface GatewayVideoPricingSkus {
    "per-video"?: string;
    "per-video-second"?: string;
    "per-video-second-1080p"?: string;
}

/** Video-model fields the gateway worker needs (mirrors `/v1/videos/models`). */
export interface GatewayVideoModelInfo {
    allowedPassthroughParameters: ReadonlyArray<string>;
    canonicalSlug: string;
    /** Cost per second of generated video, microdollars. */
    costPerSecondMicrodollars: number;
    created: number;
    description: string;
    /** Typical generation time, seconds — UX hint, not exposed in the API. */
    estimatedLatencySeconds: number;
    modelApiId: string;
    name: string;
    pricingSkus: GatewayVideoPricingSkus;
    provider: "fal";
    supportedAspectRatios: ReadonlyArray<string>;
    supportedResolutions: ReadonlyArray<string>;
    supportedSizes: ReadonlyArray<string>;
}

// `aspectRatios` in the registry may include the value "auto" (a renderer hint,
// not a real aspect ratio). The gateway catalog should advertise actual ratios
// only, so we strip it here.
const stripAuto = (ratios: ReadonlyArray<string> | undefined): ReadonlyArray<string> => (ratios ?? []).filter((r) => r !== "auto");

export const deriveImageModels = (): Record<string, GatewayImageModelInfo> => {
    const out: Record<string, GatewayImageModelInfo> = {};

    for (const definition of MODEL_REGISTRY) {
        if (definition.mode !== "image") continue;

        if (!definition.gatewayKey) continue;

        if (definition.costPerImageMicrodollars === undefined) continue;

        if (definition.provider !== "fal" && definition.provider !== "openai" && definition.provider !== "bfl") continue;

        out[definition.gatewayKey] = {
            costPerImageMicrodollars: definition.costPerImageMicrodollars,
            modelApiId: definition.gatewayModelApiId ?? definition.modelApiId,
            provider: definition.provider,
            ...(definition.maxReferenceImages !== undefined && { maxReferenceImages: definition.maxReferenceImages }),
        };
    }

    return out;
};

export const deriveVideoModels = (): Record<string, GatewayVideoModelInfo> => {
    const out: Record<string, GatewayVideoModelInfo> = {};

    for (const definition of MODEL_REGISTRY) {
        if (definition.mode !== "video") continue;

        if (!definition.gatewayKey) continue;

        if (definition.costPerSecondMicrodollars === undefined) continue;

        if (definition.provider !== "fal") continue;

        out[definition.gatewayKey] = {
            allowedPassthroughParameters: definition.gatewayAllowedPassthrough ?? [],
            canonicalSlug: definition.gatewayKey,
            costPerSecondMicrodollars: definition.costPerSecondMicrodollars,
            created: definition.gatewayCreated ?? Math.floor(Date.now() / 1000),
            description: definition.gatewayDescription ?? definition.desc ?? "",
            estimatedLatencySeconds: definition.gatewayEstimatedLatencySeconds ?? (definition.avgLatencyMs ? Math.round(definition.avgLatencyMs / 1000) : 0),
            modelApiId: definition.gatewayModelApiId ?? definition.modelApiId,
            name: definition.name ?? definition.id,
            pricingSkus: definition.gatewayPricingSkus ?? {},
            provider: definition.provider,
            supportedAspectRatios: stripAuto(definition.aspectRatios),
            supportedResolutions: definition.gatewaySupportedResolutions ?? [],
            supportedSizes: definition.gatewaySupportedSizes ?? [],
        };
    }

    return out;
};

/** Music-model fields the gateway worker needs (mirrors `/v1/music/models`). */
export interface GatewayMusicModelInfo {
    /** Whitelist of provider-specific parameters callers may pass through. */
    allowedPassthroughParameters: ReadonlyArray<string>;
    canonicalSlug: string;
    /** Cost per generation in microdollars (flat per-call rate). */
    costPerMusicGenerationMicrodollars: number;
    created: number;
    description: string;
    /** Typical generation latency in seconds — UX hint, not exposed in the API. */
    estimatedLatencySeconds: number;
    /** Max clip length in seconds. 0 means model has a fixed duration not controlled by caller. */
    maxDurationSeconds: number;
    /** Full FAL endpoint slug used as the URL path (e.g. `fal-ai/stable-audio-25/text-to-audio`). */
    modelApiId: string;
    name: string;
    provider: "fal";
    /** Output formats advertised by `/v1/music/models` (e.g. ["mp3", "wav"]). */
    supportedAudioFormats: ReadonlyArray<string>;
    /** Sample-rate buckets advertised by `/v1/music/models` (e.g. [44_100, 48_000]). */
    supportedSampleRates: ReadonlyArray<number>;
    /** Whether the model supports a `negative_prompt` parameter. */
    supportsNegativePrompt: boolean;
}

export const deriveMusicModels = (): Record<string, GatewayMusicModelInfo> => {
    const out: Record<string, GatewayMusicModelInfo> = {};

    for (const definition of MODEL_REGISTRY) {
        if (definition.mode !== "music") continue;

        if (!definition.gatewayKey) continue;

        if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

        if (definition.provider !== "fal") continue;

        out[definition.gatewayKey] = {
            allowedPassthroughParameters: definition.gatewayAllowedPassthrough ?? [],
            canonicalSlug: definition.gatewayKey,
            costPerMusicGenerationMicrodollars: definition.costPerMusicGenerationMicrodollars,
            created: definition.gatewayCreated ?? Math.floor(Date.now() / 1000),
            description: definition.gatewayDescription ?? definition.desc ?? "",
            estimatedLatencySeconds: definition.gatewayEstimatedLatencySeconds ?? (definition.avgLatencyMs ? Math.round(definition.avgLatencyMs / 1000) : 0),
            maxDurationSeconds: definition.maxMusicDurationSeconds ?? 0,
            modelApiId: definition.gatewayModelApiId ?? definition.modelApiId,
            name: definition.name ?? definition.id,
            provider: definition.provider,
            supportedAudioFormats: definition.supportedAudioFormats ?? [],
            supportedSampleRates: definition.supportedSampleRates ?? [],
            supportsNegativePrompt: definition.supportsNegativePrompt ?? false,
        };
    }

    return out;
};

/** Speech-model fields the gateway worker needs (`/internal/speech`). */
export interface GatewaySpeechModelInfo {
    /** Cost per 1,000 input characters in microdollars. */
    costPerThousandCharsMicrodollars: number;
    /** The voice used when the request names none, or one not in `voices`. */
    defaultVoice?: string;
    modelApiId: string;
    provider: "fal";
    /** Preset voice ids; empty when the model takes no preset voice. */
    voices: ReadonlyArray<string>;
}

/** Speech models, keyed by REGISTRY id — the backend names them that way; there is no public `/v1` catalog. */
export const deriveSpeechModels = (): Record<string, GatewaySpeechModelInfo> => {
    const out: Record<string, GatewaySpeechModelInfo> = {};

    for (const definition of MODEL_REGISTRY) {
        if (definition.mode !== "text-to-speech") continue;

        if (definition.enabled === false) continue;

        if (definition.costPerThousandCharsMicrodollars === undefined) continue;

        if (definition.provider !== "fal") continue;

        out[definition.id] = {
            costPerThousandCharsMicrodollars: definition.costPerThousandCharsMicrodollars,
            modelApiId: definition.gatewayModelApiId ?? definition.modelApiId,
            provider: definition.provider,
            voices: definition.ttsVoices ?? [],
            ...(definition.ttsDefaultVoice !== undefined && { defaultVoice: definition.ttsDefaultVoice }),
        };
    }

    return out;
};

/**
 * The model hands-free voice mode speaks with: the fast MiniMax, since a reply
 * is read sentence by sentence and every one waits on a round trip.
 */
export const DEFAULT_SPEECH_MODEL = "fal-ai/minimax/speech-02-turbo";

/** Pre-derived map; safe to import at module load. */
export const GATEWAY_IMAGE_MODELS: Record<string, GatewayImageModelInfo> = deriveImageModels();

/** Pre-derived map; safe to import at module load. */
export const GATEWAY_VIDEO_MODELS: Record<string, GatewayVideoModelInfo> = deriveVideoModels();

/** Pre-derived map; safe to import at module load. */
export const GATEWAY_MUSIC_MODELS: Record<string, GatewayMusicModelInfo> = deriveMusicModels();

/** Pre-derived map; safe to import at module load. */
export const GATEWAY_SPEECH_MODELS: Record<string, GatewaySpeechModelInfo> = deriveSpeechModels();
