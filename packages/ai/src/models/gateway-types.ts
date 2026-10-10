/**
 * Canonical model shape returned by the LLM Gateway `/v1/models` endpoint.
 *
 * This is the **single source of truth** for model data on the frontend.
 * The gateway enriches models with pricing and region data; clients consume
 * this type directly — no mapping or transformation needed.
 *
 * Backend-only fields (contextOptions, instructions, maxSteps, maxRetries,
 * providerOptions) live in `ModelDefinition` and are NOT part of this type.
 */
export interface GatewayModel {
    // ── Image/video capabilities ─────────────────────────────────────
    aspectRatios?: string[];
    avgLatencyMs?: number;
    characterRefModes?: string[];
    context_window?: number;
    controlNetTypes?: string[];
    desc?: string;

    displayProvider?: string;
    enabled: boolean;
    featureFlag?: string;
    filterCapabilities?: string[];
    id: string;

    isNew?: boolean;
    // ── Flags ────────────────────────────────────────────────────────
    isPremium?: boolean;
    isPreprocessor?: boolean;

    legacy?: boolean;
    maxDuration?: number;
    maxReferenceImages?: number;
    maxResolution?: string;
    maxVideoDuration?: number;
    mode: "text" | "image" | "video" | "speech-to-text" | "text-to-speech";
    modelApiId: string;
    // ── Display ──────────────────────────────────────────────────────
    name?: string;
    preprocessorType?: string;
    // ── Pricing (enriched by gateway from models.dev) ────────────────
    pricing?: {
        cached_input_per_million?: number;
        input_per_million: number;
        output_per_million: number;
    };
    provider: string;
    regions: string[];
    slug?: string;
    supportedFps?: number[];
    supportsBackgroundRemoval?: boolean;
    supportsCharacterRef?: boolean;
    supportsControlNet?: boolean;
    supportsFaceEnhance?: boolean;
    supportsFileInput: boolean;
    supportsImageToVideo?: boolean;
    supportsImg2Img?: boolean;
    supportsInpaint?: boolean;
    supportsMultimodal: boolean;
    supportsNegativePrompt?: boolean;
    supportsObjectRemoval?: boolean;

    supportsOutpaint?: boolean;
    supportsStyleRef?: boolean;
    supportsTextToVideo?: boolean;
    // ── Capabilities (flat booleans) ─────────────────────────────────
    supportsTools: boolean;
    supportsUpscale?: boolean;

    tier?: "budget" | "fast" | "frontier" | "high-quality" | "medium";
    upscaleFactors?: number[];
}
