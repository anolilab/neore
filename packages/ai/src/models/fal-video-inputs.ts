/**
 * Per-endpoint FAL video inputs, read from each endpoint's OpenAPI input schema and keyed by the
 * registry's `modelApiId`. Pure data and lookups with no imports: the backend's FAL request
 * builders and the workflow's video controls both read them, so nothing here may pull in a runtime.
 */

/** How an endpoint takes `duration`: `int` is a JSON number, `text` a numeric string ("5"), `seconds` a string with an s ("5s"). */
interface FalDurationSpec {
    format: "int" | "seconds" | "text";
    /** Seconds the endpoint accepts. The schema's `"auto"` is left out: a duration here is always a number. */
    values: ReadonlyArray<number>;
}

/** `resolution`: the values the endpoint accepts, and what it uses when none is sent. */
interface FalResolutionSpec {
    default: string;
    values: ReadonlyArray<string>;
}

/**
 * The reference inputs of an endpoint: the FAL field each modality is sent under. A field is
 * present only when the endpoint takes that modality, and the registry row's `maxReference*`
 * cap says how many may be sent (the drift test pins the two together).
 */
interface FalVideoReferenceSpec {
    audios?: string;
    images?: string;
    /** Combined length, in seconds, of the reference videos the endpoint accepts. */
    totalSeconds?: number;
    videos?: string;
}

export interface FalVideoInputSpec {
    /** Whether the endpoint takes `aspect_ratio` at all. */
    aspectRatio: boolean;
    /** What the endpoint does when `generate_audio` is not sent. `null` when it has no such input. */
    audioDefault: boolean | null;
    /** `null` when the endpoint has no `duration` input, so its length is fixed and nothing is sent. */
    duration: FalDurationSpec | null;
    references?: FalVideoReferenceSpec;
    /** `null` when the endpoint has no `resolution` input. */
    resolution: FalResolutionSpec | null;

    /**
     * The field the start frame is sent under when the endpoint has no reference array to put it in.
     * Defaults to `image_url`; `start_image_url` is the name on the Kling v3 and o3 endpoints.
     */
    startImage?: string;
}

export interface VideoOptions {
    generateAudio?: boolean;
    resolution?: string;
}

const range = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, index) => min + index);

const DURATION_SEEDANCE: FalDurationSpec = { format: "text", values: range(4, 15) };
const DURATION_SEEDANCE_15: FalDurationSpec = { format: "text", values: range(4, 12) };
const DURATION_KLING_O3: FalDurationSpec = { format: "text", values: range(3, 15) };
const DURATION_KLING: FalDurationSpec = { format: "text", values: [5, 10] };
const DURATION_HAILUO: FalDurationSpec = { format: "text", values: [6, 10] };
const DURATION_PIKA: FalDurationSpec = { format: "int", values: [5, 10] };
const DURATION_RAY_2: FalDurationSpec = { format: "seconds", values: [5, 9] };
const DURATION_VEO2: FalDurationSpec = { format: "seconds", values: range(5, 8) };
const DURATION_VEO: FalDurationSpec = { format: "seconds", values: [4, 6, 8] };
const DURATION_VEO_REFERENCE: FalDurationSpec = { format: "seconds", values: [8] };
const DURATION_OMNI: FalDurationSpec = { format: "int", values: range(3, 10) };
const DURATION_GROK: FalDurationSpec = { format: "int", values: range(1, 15) };

const RESOLUTION_SEEDANCE_FAST: FalResolutionSpec = { default: "720p", values: ["480p", "720p"] };
const RESOLUTION_SEEDANCE: FalResolutionSpec = { default: "720p", values: ["480p", "720p", "1080p", "4k"] };
const RESOLUTION_SEEDANCE_15: FalResolutionSpec = { default: "720p", values: ["480p", "720p", "1080p"] };
const RESOLUTION_VEO_3: FalResolutionSpec = { default: "720p", values: ["720p", "1080p"] };
const RESOLUTION_VEO_31: FalResolutionSpec = { default: "720p", values: ["720p", "1080p", "4k"] };
const RESOLUTION_PIKA: FalResolutionSpec = { default: "720p", values: ["720p", "1080p"] };
const RESOLUTION_RAY_2: FalResolutionSpec = { default: "540p", values: ["540p", "720p", "1080p"] };
const RESOLUTION_HAILUO_STANDARD: FalResolutionSpec = { default: "768P", values: ["512P", "768P"] };
const RESOLUTION_OMNI: FalResolutionSpec = { default: "720p", values: ["360p", "720p", "1080p", "4k"] };
const RESOLUTION_GROK: FalResolutionSpec = { default: "720p", values: ["480p", "720p", "1080p"] };

/**
 * FAL video inputs from each endpoint's OpenAPI input schema, keyed by the registry's `modelApiId`.
 * `"unverified"` marks an endpoint whose schema could not be fetched: it gets the request it had
 * before this table (the number as given, `aspect_ratio` when set) and no audio or resolution
 * control. Every enabled fal video row must have an entry (`fal-video-inputs.test.ts` checks).
 */
export const FAL_VIDEO_INPUTS: Record<string, FalVideoInputSpec | "unverified"> = {
    "bytedance/seedance-2.0/fast/image-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_SEEDANCE, resolution: RESOLUTION_SEEDANCE_FAST },
    "bytedance/seedance-2.0/fast/reference-to-video": {
        aspectRatio: true,
        audioDefault: true,
        duration: DURATION_SEEDANCE,
        references: { audios: "audio_urls", images: "image_urls", totalSeconds: 15, videos: "video_urls" },
        resolution: RESOLUTION_SEEDANCE_FAST,
    },
    "bytedance/seedance-2.0/fast/text-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_SEEDANCE, resolution: RESOLUTION_SEEDANCE_FAST },
    "bytedance/seedance-2.0/image-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_SEEDANCE, resolution: RESOLUTION_SEEDANCE },
    "bytedance/seedance-2.0/reference-to-video": {
        aspectRatio: true,
        audioDefault: true,
        duration: DURATION_SEEDANCE,
        references: { audios: "audio_urls", images: "image_urls", totalSeconds: 15, videos: "video_urls" },
        resolution: RESOLUTION_SEEDANCE,
    },
    "bytedance/seedance-2.0/text-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_SEEDANCE, resolution: RESOLUTION_SEEDANCE },
    "fal-ai/bytedance/seedance/v1.5/lite/image-to-video": "unverified",
    "fal-ai/bytedance/seedance/v1.5/lite/text-to-video": "unverified",
    "fal-ai/bytedance/seedance/v1.5/pro/image-to-video": {
        aspectRatio: true,
        audioDefault: true,
        duration: DURATION_SEEDANCE_15,
        resolution: RESOLUTION_SEEDANCE_15,
    },
    "fal-ai/bytedance/seedance/v1.5/pro/text-to-video": {
        aspectRatio: true,
        audioDefault: true,
        duration: DURATION_SEEDANCE_15,
        resolution: RESOLUTION_SEEDANCE_15,
    },
    "fal-ai/kling-video/o1/standard/video-to-video/edit": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/kling-video/o3/4k/image-to-video": { aspectRatio: false, audioDefault: false, duration: DURATION_KLING_O3, resolution: null },
    "fal-ai/kling-video/o3/4k/reference-to-video": {
        aspectRatio: true,
        audioDefault: false,
        duration: DURATION_KLING_O3,
        resolution: null,
        startImage: "start_image_url",
    },
    "fal-ai/kling-video/o3/4k/text-to-video": { aspectRatio: true, audioDefault: false, duration: DURATION_KLING_O3, resolution: null },
    "fal-ai/kling-video/o3/standard/image-to-video": { aspectRatio: false, audioDefault: false, duration: DURATION_KLING_O3, resolution: null },
    "fal-ai/kling-video/v1.5/pro/image-to-video": { aspectRatio: true, audioDefault: null, duration: DURATION_KLING, resolution: null },
    "fal-ai/kling-video/v1.5/pro/text-to-video": { aspectRatio: true, audioDefault: null, duration: DURATION_KLING, resolution: null },
    "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_KLING, resolution: null },
    "fal-ai/kling-video/v2.5-turbo/pro/text-to-video": { aspectRatio: true, audioDefault: null, duration: DURATION_KLING, resolution: null },
    "fal-ai/kling-video/v3/4k/image-to-video": {
        aspectRatio: false,
        audioDefault: true,
        duration: DURATION_KLING_O3,
        resolution: null,
        startImage: "start_image_url",
    },
    "fal-ai/kling-video/v3/4k/text-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_KLING_O3, resolution: null },
    "fal-ai/kling-video/v3/pro/image-to-video": {
        aspectRatio: false,
        audioDefault: true,
        duration: DURATION_KLING_O3,
        resolution: null,
        startImage: "start_image_url",
    },
    "fal-ai/ltx-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/luma-dream-machine": { aspectRatio: true, audioDefault: null, duration: null, resolution: null },
    "fal-ai/luma-dream-machine/image-to-video": { aspectRatio: true, audioDefault: null, duration: null, resolution: null },
    "fal-ai/luma-dream-machine/ray-2": { aspectRatio: true, audioDefault: null, duration: DURATION_RAY_2, resolution: RESOLUTION_RAY_2 },
    "fal-ai/minimax/hailuo-02/pro/image-to-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/minimax/hailuo-02/pro/text-to-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/minimax/hailuo-02/standard/image-to-video": {
        aspectRatio: false,
        audioDefault: null,
        duration: DURATION_HAILUO,
        resolution: RESOLUTION_HAILUO_STANDARD,
    },
    "fal-ai/minimax/hailuo-02/standard/text-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_HAILUO, resolution: null },
    "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_HAILUO, resolution: null },
    "fal-ai/minimax/hailuo-2.3-fast/standard/text-to-video": "unverified",
    "fal-ai/minimax/hailuo-2.3/pro/image-to-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/minimax/hailuo-2.3/pro/text-to-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/minimax/hailuo-2.3/standard/image-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_HAILUO, resolution: null },
    "fal-ai/minimax/hailuo-2.3/standard/text-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_HAILUO, resolution: null },
    "fal-ai/minimax/video-01": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/minimax/video-01-live": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/minimax/video-01-live/image-to-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/pika/v2.2/image-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_PIKA, resolution: RESOLUTION_PIKA },
    "fal-ai/pika/v2.2/text-to-video": { aspectRatio: true, audioDefault: null, duration: DURATION_PIKA, resolution: RESOLUTION_PIKA },
    "fal-ai/stable-video": { aspectRatio: false, audioDefault: null, duration: null, resolution: null },
    "fal-ai/veo2": { aspectRatio: true, audioDefault: null, duration: DURATION_VEO2, resolution: null },
    "fal-ai/veo2/image-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_VEO2, resolution: null },
    "fal-ai/veo3": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_3 },
    "fal-ai/veo3.1": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_31 },
    "fal-ai/veo3.1/fast": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_31 },
    "fal-ai/veo3.1/fast/image-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_31 },
    "fal-ai/veo3.1/fast/reference-to-video": {
        aspectRatio: true,
        audioDefault: true,
        duration: DURATION_VEO_REFERENCE,
        references: { images: "image_urls" },
        resolution: RESOLUTION_VEO_31,
    },
    "fal-ai/veo3.1/image-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_31 },
    "fal-ai/veo3.1/reference-to-video": {
        aspectRatio: true,
        audioDefault: true,
        duration: DURATION_VEO_REFERENCE,
        references: { images: "image_urls" },
        resolution: RESOLUTION_VEO_31,
    },
    "fal-ai/veo3/fast": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_3 },
    "fal-ai/veo3/fast/image-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_3 },
    "fal-ai/veo3/image-to-video": { aspectRatio: true, audioDefault: true, duration: DURATION_VEO, resolution: RESOLUTION_VEO_3 },
    "google/gemini-omni-flash/v1.1/reference-to-video": {
        aspectRatio: true,
        audioDefault: null,
        duration: DURATION_OMNI,
        references: { images: "image_urls", videos: "reference_video_urls" },
        resolution: RESOLUTION_OMNI,
    },
    "xai/grok-imagine-video/v1.5/image-to-video": { aspectRatio: false, audioDefault: null, duration: DURATION_GROK, resolution: RESOLUTION_GROK },
};

/** The endpoint's verified spec, or `undefined` for an unverified or unknown endpoint. */
export const falVideoInputsOf = (modelApiId: string | undefined): FalVideoInputSpec | undefined => {
    const spec = modelApiId === undefined ? undefined : FAL_VIDEO_INPUTS[modelApiId];

    return spec && spec !== "unverified" ? spec : undefined;
};

/** The `generate_audio` default and resolution list of a verified endpoint. `undefined` for an unverified or unknown one. */
export const videoOptionsOf = (modelApiId: string | undefined): Pick<FalVideoInputSpec, "audioDefault" | "resolution"> | undefined => {
    const spec = falVideoInputsOf(modelApiId);

    return spec && { audioDefault: spec.audioDefault, resolution: spec.resolution };
};

/**
 * The options to send to an endpoint. Each is kept only when the endpoint takes it: audio when
 * the endpoint has a `generate_audio` input, and resolution as one of its values (matched without
 * case, so "768p" becomes "768P"). Anything else is dropped, and an unset option is never sent.
 */
export const snapVideoOptions = (modelApiId: string | undefined, options: VideoOptions): VideoOptions => {
    const spec = videoOptionsOf(modelApiId);
    const result: VideoOptions = {};

    if (typeof spec?.audioDefault === "boolean" && typeof options.generateAudio === "boolean") {
        result.generateAudio = options.generateAudio;
    }

    if (spec?.resolution && typeof options.resolution === "string") {
        const wanted = options.resolution.toLowerCase();
        const match = spec.resolution.values.find((value) => value.toLowerCase() === wanted);

        if (match !== undefined) {
            result.resolution = match;
        }
    }

    return result;
};

/** Free plans render at most this height. A higher resolution is snapped down to the endpoint's highest value at or below it. */
export const FREE_PLAN_MAX_HEIGHT = 1080;

/** The pixel height a resolution names ("1080p" is 1080, "4k" is 2160), or `undefined` for anything else. */
const RESOLUTION_NAME = /^(\d+)([pk])$/iu;

const heightOf = (resolution: string): number | undefined => {
    const match = RESOLUTION_NAME.exec(resolution.trim());

    if (!match) {
        return undefined;
    }

    const perUnit = match[2]?.toLowerCase() === "k" ? 540 : 1;

    return Number(match[1]) * perUnit;
};

/**
 * The resolution a free plan may use in place of `resolution`, which must already be one of the
 * endpoint's values (`snapVideoOptions`). At or under the cap it is kept. Above it, the endpoint's
 * highest value under the cap is used, so a request is never rounded up. `undefined` when the
 * endpoint has no value under the cap.
 */
export const resolutionWithinFreePlan = (modelApiId: string | undefined, resolution: string): string | undefined => {
    const height = heightOf(resolution);

    if (height !== undefined && height <= FREE_PLAN_MAX_HEIGHT) {
        return resolution;
    }

    const allowed = (videoOptionsOf(modelApiId)?.resolution?.values ?? [])
        .map((value) => {
            return { height: heightOf(value), value };
        })
        .filter((entry): entry is { height: number; value: string } => entry.height !== undefined && entry.height <= FREE_PLAN_MAX_HEIGHT);

    return allowed.toSorted((a, b) => b.height - a.height)[0]?.value;
};

/**
 * Whether a requested resolution would render above the free plan's cap, after snapping to the
 * endpoint's values. A resolution with no readable height counts as above it. Only then does a run
 * need the caller's plan.
 */
export const exceedsFreePlanCap = (modelApiId: string | undefined, resolution: string | undefined): boolean => {
    const snapped = snapVideoOptions(modelApiId, { resolution }).resolution;

    if (snapped === undefined) {
        return false;
    }

    const height = heightOf(snapped);

    return height === undefined || height > FREE_PLAN_MAX_HEIGHT;
};
