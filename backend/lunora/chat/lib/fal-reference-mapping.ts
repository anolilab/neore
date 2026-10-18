import type { ModelDefinition } from "@neore/ai/models";

/**
 * FAL endpoint -> reference-media field mapping for the reference picker and the workflow's
 * video nodes. Images, videos and audio each have their own FAL field, and the endpoints
 * diverge on how they take them.
 *
 * - Multi-ref-capable image models (Nano-Banana family, FLUX Pro Redux) accept
 *   `image_urls: string[]` for the full ordered list.
 * - Single-ref models (IP-Adapter Face, PuLID, Style Transfer) accept only
 *   `image_url: string` — anything past index 0 is ignored.
 *
 * The conservative pattern from {@link generateCharacterRef} is to always
 * populate `image_url` with the first URL AND `image_urls` with the full array
 * for multi-ref-capable models. Single-ref models just get `image_url`.
 */

interface ReferenceImageMapping {
    /** Single-image input field (always populated when refs > 0). */
    image_url?: string;
    /** Multi-image input field (only set when the model supports more than one ref). */
    image_urls?: string[];
}

/**
 * Build the FAL input fragment for the supplied reference image URLs.
 * @param modelDefinition registry entry for the target model. Used to look up
 * `maxReferenceImages` so we don't oversend to a model
 * that ignores extras.
 * @param referenceImages ordered URLs from the composer's reference picker.
 * Order is preserved (the badge index the user saw).
 * @returns object to spread into the FAL providerOptions (or direct REST input).
 * Empty object when there are no references — caller can spread it
 * unconditionally without checks.
 */
export const buildFalReferenceImageInput = (modelDefinition: ModelDefinition, referenceImages: ReadonlyArray<string> | undefined): ReferenceImageMapping => {
    if (!referenceImages || referenceImages.length === 0) {
        return {};
    }

    const cap = modelDefinition.maxReferenceImages ?? 0;

    if (cap <= 0) {
        // Model doesn't support reference images — drop silently rather than 400.
        // The composer gates by the same flag, so this branch is mostly defence
        // against a stale tool-call argument arriving after a model swap.
        return {};
    }

    const clamped = referenceImages.slice(0, cap);
    const primary = clamped[0];

    if (!primary) {
        return {};
    }

    const result: ReferenceImageMapping = { image_url: primary };

    if (cap > 1 && clamped.length > 1) {
        result.image_urls = [...clamped];
    }

    return result;
};

interface FalReferenceField {
    name: string;
    /** Endpoint takes one URL under `name` instead of an array. */
    singular?: boolean;
}

interface FalVideoReferenceSpec {
    audios?: FalReferenceField;
    /** The endpoint's `duration` is a string enum of whole seconds in this range, not a number. */
    durationSeconds?: { max: number; min: number };
    /** Fixed fields the endpoint requires alongside the references. */
    extra?: Record<string, string>;
    images?: FalReferenceField;
    /** Combined length, in seconds, of the reference videos the endpoint accepts. */
    totalSeconds?: number;
    videos?: FalReferenceField;
}

/**
 * Per-endpoint FAL field names for reference video/audio, keyed by the
 * registry's `modelApiId`. Each name is copied from the endpoint's OpenAPI
 * input schema. An endpoint with no entry takes no reference media.
 */
const FAL_VIDEO_REFERENCE_FIELDS: Record<string, FalVideoReferenceSpec> = {
    "bytedance/seedance-2.0/fast/reference-to-video": {
        audios: { name: "audio_urls" },
        durationSeconds: { max: 15, min: 4 },
        images: { name: "image_urls" },
        totalSeconds: 15,
        videos: { name: "video_urls" },
    },
    "bytedance/seedance-2.0/reference-to-video": {
        audios: { name: "audio_urls" },
        durationSeconds: { max: 15, min: 4 },
        images: { name: "image_urls" },
        totalSeconds: 15,
        videos: { name: "video_urls" },
    },
    "google/gemini-omni-flash/v1.1/reference-to-video": {
        images: { name: "image_urls" },
        videos: { name: "reference_video_urls" },
    },
};

/**
 * The `duration` to send for an endpoint. FAL documents Seedance 2.0 reference-to-video's as a
 * string enum of whole seconds (4 to 15, or "auto"), so a number is sent as the nearest allowed
 * string; every other endpoint keeps the number it was given.
 */
export const falDurationInput = (modelDefinition: ModelDefinition | undefined, duration: number | undefined): number | string | undefined => {
    const range = modelDefinition && FAL_VIDEO_REFERENCE_FIELDS[modelDefinition.modelApiId]?.durationSeconds;

    if (duration === undefined || !range) {
        return duration;
    }

    return String(Math.min(range.max, Math.max(range.min, Math.round(duration))));
};

/**
 * The most seconds of reference video a model takes in total, or `undefined` when there is no
 * such limit to check. A pre-run check only: the endpoint enforces its own limits too.
 */
export const referenceVideoLimitSeconds = (modelDefinition: ModelDefinition | undefined): number | undefined => {
    if (!modelDefinition || !modelDefinition.maxReferenceVideos) {
        return undefined;
    }

    return FAL_VIDEO_REFERENCE_FIELDS[modelDefinition.modelApiId]?.totalSeconds;
};

/**
 * Build the FAL input fragment for the start frame and reference videos and audio, clamped to
 * the model's `maxReferenceImages` / `maxReferenceVideos` / `maxReferenceAudios`. Modalities the
 * endpoint cannot take are dropped, as the image helper does. With no model (an unknown id) only
 * the start frame is sent, as `image_url`.
 * @returns object to spread into the FAL input. Empty when nothing applies.
 */
export const buildFalReferenceVideoInput = (
    modelDefinition: ModelDefinition | undefined,
    references: {
        referenceAudioUrls?: ReadonlyArray<string>;
        referenceVideoUrls?: ReadonlyArray<string>;
        /** Image-to-video start frame. Becomes the image array's first entry when the endpoint has one. */
        startFrameUrl?: string;
    },
): Record<string, string | string[]> => {
    const spec: FalVideoReferenceSpec = (modelDefinition && FAL_VIDEO_REFERENCE_FIELDS[modelDefinition.modelApiId]) ?? {};
    const result: Record<string, string | string[]> = { ...spec.extra };

    // An endpoint without an image array takes the start frame as `image_url`.
    if (references.startFrameUrl && !spec.images) {
        result.image_url = references.startFrameUrl;
    }

    const place = (field: FalReferenceField | undefined, urls: ReadonlyArray<string> | undefined, cap: number | undefined) => {
        if (!field || !urls || urls.length === 0 || !cap || cap <= 0) {
            return;
        }

        const clamped = urls.slice(0, cap);
        const [first] = clamped;

        if (!first) {
            return;
        }

        result[field.name] = field.singular ? first : [...clamped];
    };

    place(spec.images, references.startFrameUrl ? [references.startFrameUrl] : undefined, modelDefinition?.maxReferenceImages);
    place(spec.videos, references.referenceVideoUrls, modelDefinition?.maxReferenceVideos);
    place(spec.audios, references.referenceAudioUrls, modelDefinition?.maxReferenceAudios);

    return result;
};
