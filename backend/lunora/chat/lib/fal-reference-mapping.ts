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
        images: { name: "image_urls" },
        totalSeconds: 15,
        videos: { name: "video_urls" },
    },
    "bytedance/seedance-2.0/reference-to-video": {
        audios: { name: "audio_urls" },
        images: { name: "image_urls" },
        totalSeconds: 15,
        videos: { name: "video_urls" },
    },
    "google/gemini-omni-flash/v1.1/reference-to-video": {
        images: { name: "image_urls" },
        videos: { name: "reference_video_urls" },
    },
};

const range = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, index) => min + index);

/** How an endpoint takes `duration`: `int` is a JSON number, `text` a numeric string ("5"), `seconds` a string with an s ("5s"). */
interface FalDurationSpec {
    format: "int" | "seconds" | "text";
    /** Seconds the endpoint accepts. The schema's `"auto"` is left out: a duration here is always a number. */
    values: ReadonlyArray<number>;
}

interface FalVideoInputSpec {
    /** Whether the endpoint takes `aspect_ratio` at all. */
    aspectRatio: boolean;
    /** `null` when the endpoint has no `duration` input, so its length is fixed and nothing is sent. */
    duration: FalDurationSpec | null;
}

/**
 * FAL video inputs from each endpoint's OpenAPI input schema, keyed by the registry's `modelApiId`.
 * `"unverified"` marks an endpoint whose schema could not be fetched: its row keeps the behaviour
 * it had before this table (the number as given, `aspect_ratio` when set). Every enabled fal video
 * row must have an entry (`fal-reference-mapping.test.ts` checks).
 */
export const FAL_VIDEO_INPUTS: Record<string, FalVideoInputSpec | "unverified"> = {
    "bytedance/seedance-2.0/fast/image-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 15) } },
    "bytedance/seedance-2.0/fast/reference-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 15) } },
    "bytedance/seedance-2.0/fast/text-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 15) } },
    "bytedance/seedance-2.0/image-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 15) } },
    "bytedance/seedance-2.0/reference-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 15) } },
    "bytedance/seedance-2.0/text-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 15) } },
    "fal-ai/bytedance/seedance/v1.5/lite/image-to-video": "unverified",
    "fal-ai/bytedance/seedance/v1.5/lite/text-to-video": "unverified",
    "fal-ai/bytedance/seedance/v1.5/pro/image-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 12) } },
    "fal-ai/bytedance/seedance/v1.5/pro/text-to-video": { aspectRatio: true, duration: { format: "text", values: range(4, 12) } },
    "fal-ai/kling-video/o1/standard/video-to-video/edit": { aspectRatio: false, duration: null },
    "fal-ai/kling-video/o3/4k/image-to-video": { aspectRatio: false, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/kling-video/o3/4k/reference-to-video": { aspectRatio: true, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/kling-video/o3/4k/text-to-video": { aspectRatio: true, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/kling-video/o3/standard/image-to-video": { aspectRatio: false, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/kling-video/v1.5/pro/image-to-video": { aspectRatio: true, duration: { format: "text", values: [5, 10] } },
    "fal-ai/kling-video/v1.5/pro/text-to-video": { aspectRatio: true, duration: { format: "text", values: [5, 10] } },
    "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": { aspectRatio: false, duration: { format: "text", values: [5, 10] } },
    "fal-ai/kling-video/v2.5-turbo/pro/text-to-video": { aspectRatio: true, duration: { format: "text", values: [5, 10] } },
    "fal-ai/kling-video/v3/4k/image-to-video": { aspectRatio: false, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/kling-video/v3/4k/text-to-video": { aspectRatio: true, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/kling-video/v3/pro/image-to-video": { aspectRatio: false, duration: { format: "text", values: range(3, 15) } },
    "fal-ai/ltx-video": { aspectRatio: false, duration: null },
    "fal-ai/luma-dream-machine": { aspectRatio: true, duration: null },
    "fal-ai/luma-dream-machine/image-to-video": { aspectRatio: true, duration: null },
    "fal-ai/luma-dream-machine/ray-2": { aspectRatio: true, duration: { format: "seconds", values: [5, 9] } },
    "fal-ai/minimax/hailuo-02/pro/image-to-video": { aspectRatio: false, duration: null },
    "fal-ai/minimax/hailuo-02/pro/text-to-video": { aspectRatio: false, duration: null },
    "fal-ai/minimax/hailuo-02/standard/image-to-video": { aspectRatio: false, duration: { format: "text", values: [6, 10] } },
    "fal-ai/minimax/hailuo-02/standard/text-to-video": { aspectRatio: false, duration: { format: "text", values: [6, 10] } },
    "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video": { aspectRatio: false, duration: { format: "text", values: [6, 10] } },
    "fal-ai/minimax/hailuo-2.3-fast/standard/text-to-video": "unverified",
    "fal-ai/minimax/hailuo-2.3/pro/image-to-video": { aspectRatio: false, duration: null },
    "fal-ai/minimax/hailuo-2.3/pro/text-to-video": { aspectRatio: false, duration: null },
    "fal-ai/minimax/hailuo-2.3/standard/image-to-video": { aspectRatio: false, duration: { format: "text", values: [6, 10] } },
    "fal-ai/minimax/hailuo-2.3/standard/text-to-video": { aspectRatio: false, duration: { format: "text", values: [6, 10] } },
    "fal-ai/minimax/video-01": { aspectRatio: false, duration: null },
    "fal-ai/minimax/video-01-live": { aspectRatio: false, duration: null },
    "fal-ai/minimax/video-01-live/image-to-video": { aspectRatio: false, duration: null },
    "fal-ai/pika/v2.2/image-to-video": { aspectRatio: false, duration: { format: "int", values: [5, 10] } },
    "fal-ai/pika/v2.2/text-to-video": { aspectRatio: true, duration: { format: "int", values: [5, 10] } },
    "fal-ai/stable-video": { aspectRatio: false, duration: null },
    "fal-ai/veo2": { aspectRatio: true, duration: { format: "seconds", values: range(5, 8) } },
    "fal-ai/veo2/image-to-video": { aspectRatio: false, duration: { format: "seconds", values: range(5, 8) } },
    "fal-ai/veo3": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1/fast": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1/fast/first-last-frame-to-video": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1/fast/image-to-video": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1/fast/reference-to-video": { aspectRatio: true, duration: { format: "seconds", values: [8] } },
    "fal-ai/veo3.1/first-last-frame-to-video": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1/image-to-video": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3.1/reference-to-video": { aspectRatio: true, duration: { format: "seconds", values: [8] } },
    "fal-ai/veo3/fast": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3/fast/image-to-video": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "fal-ai/veo3/image-to-video": { aspectRatio: true, duration: { format: "seconds", values: [4, 6, 8] } },
    "google/gemini-omni-flash/v1.1/reference-to-video": { aspectRatio: true, duration: { format: "int", values: range(3, 10) } },
    "xai/grok-imagine-video/v1.5/image-to-video": { aspectRatio: false, duration: { format: "int", values: range(1, 15) } },
};

/**
 * The `duration` to send for an endpoint: the number snapped to the nearest value the endpoint
 * accepts, in the format its schema names. `undefined` when the endpoint has no `duration` input
 * (send nothing) or when nothing was asked for. An unverified endpoint gets the number as given.
 */
export const falDurationInput = (modelDefinition: ModelDefinition | undefined, duration: number | undefined): number | string | undefined => {
    if (duration === undefined) {
        return undefined;
    }

    const spec = modelDefinition && FAL_VIDEO_INPUTS[modelDefinition.modelApiId];

    if (!spec || spec === "unverified") {
        return duration;
    }

    if (!spec.duration) {
        return undefined;
    }

    const { format, values } = spec.duration;
    let nearest = values[0] ?? duration;

    for (const value of values) {
        if (Math.abs(value - duration) < Math.abs(nearest - duration)) {
            nearest = value;
        }
    }

    if (format === "int") {
        return nearest;
    }

    return format === "seconds" ? `${nearest}s` : String(nearest);
};

/** Whether `aspect_ratio` goes to the endpoint. An unverified endpoint is sent it, as before. */
export const falAcceptsAspectRatio = (modelDefinition: ModelDefinition | undefined): boolean => {
    const spec = modelDefinition && FAL_VIDEO_INPUTS[modelDefinition.modelApiId];

    return !spec || spec === "unverified" || spec.aspectRatio;
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
