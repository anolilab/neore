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

/**
 * What fal charges an endpoint, in microdollars (1 credit = 1,000). Read from each endpoint's fal.ai model
 * page on 2026-10-18: the page's "Your request will cost" line, its pricing widget and its prose. Where a
 * page states two figures for one option, the higher is used, except Veo 3 and Veo 3 Fast, whose
 * per-second widget and structured price (the lower) are used over a readme section that disagrees.
 * Token-priced endpoints are the page's token formula at 24 fps and 16:9 frames.
 *
 * Read by the workflow's billing only (`falVideoMicrodollarsOf`). The gateway prices its own rows from
 * the registry's `costPerSecondMicrodollars`, which is not touched by this table.
 */

/** Microdollars per unit: one rate, or one by `generate_audio` (`on` is the audio-on rate). */
export type FalVideoRate = number | { off: number; on: number };

export interface FalVideoPrice {
    /** Seconds per billed block, for unit `block`. */
    blockSeconds?: number;
    /** A flat price per clip by billed seconds (Hailuo 2.3's 6 s and 10 s tiers). A length not listed is charged the highest. */
    byDuration?: Record<number, number>;
    /** The rate per resolution the endpoint is sent (or its default). A resolution not listed is charged the highest rate. */
    byResolution?: Record<string, FalVideoRate>;
    /** The clip length of an endpoint with no `duration` input, which makes one fixed length. Billed and used for frame cuts. */
    fixedSeconds?: number;
    /** Microdollars per image sent, the start frame included. */
    perImage?: number;
    /** The rate, for an endpoint with no resolution choice. */
    rate?: FalVideoRate;

    /**
     * With reference videos sent, the output is billed at this multiple of the rate over the output plus the reference
     * seconds (fal's token count covers both), instead of over the output alone.
     */
    referenceVideoMultiplier?: number;

    /**
     * What the rate is per: `second` (each output second), `block` (each `blockSeconds`, rounded up), or
     * `video` (each clip). A `byDuration` table is always per clip.
     */
    unit: "block" | "second" | "video";
}

export interface FalVideoBillingInput {
    /** Images sent with the call, the start frame included. */
    images: number;
    /** The options the action sends, as `snapVideoOptions` keeps them. */
    options: VideoOptions;

    /**
     * Seconds of reference video sent with the call: the wired clips' known lengths, or the endpoint's budget when a
     * wired clip's length is unknown (an upload). 0 when none is sent.
     */
    referenceSeconds: number;
    /** Billed output seconds: the duration the endpoint is sent, or its default. */
    seconds: number;
}

/** Microdollars per token of a 24 fps frame of `width` x `height` (fal's `(h x w x fps x s) / 1024` token count). */
const tokenRate = (width: number, height: number, microdollarsPerToken: number): number => Math.round(((width * height * 24) / 1024) * microdollarsPerToken);

const highestOf = (rate: FalVideoRate): number => (typeof rate === "number" ? rate : Math.max(rate.off, rate.on));

/** One rate for an option: `off` or `on` by audio, the higher of the two when the audio setting is not known. */
const rateFor = (rate: FalVideoRate, audio: boolean | undefined): number => {
    if (typeof rate === "number") {
        return rate;
    }

    if (audio === undefined) {
        return highestOf(rate);
    }

    return audio ? rate.on : rate.off;
};

/** A table's rate for the resolution sent, or the highest rate in the table when the resolution is not in it. */
const resolutionRate = (table: Record<string, FalVideoRate>, resolution: string | undefined, audio: boolean | undefined): number => {
    const listed = resolution === undefined ? undefined : table[resolution];
    const highest = Math.max(...Object.values(table).map((rate) => highestOf(rate)));

    return rateFor(listed ?? highest, audio);
};

/** The clip price for a billed length in a duration table, or the highest tier when the length is not listed. */
const durationPrice = (table: Record<number, number>, seconds: number): number => {
    const listed = table[seconds];

    return listed ?? table[Math.max(...Object.keys(table).map(Number))] ?? 0;
};

/** Seedance 2.0 frame sizes at 16:9 (fal's token count, 24 fps), in microdollars per token. */
const SEEDANCE_2 = {
    "4k": tokenRate(3840, 2160, 8),
    "480p": tokenRate(854, 480, 14),
    "720p": 303_400,
    "1080p": 682_000,
};
const SEEDANCE_2_FAST = { "480p": tokenRate(854, 480, 11.2), "720p": 241_900 };
const SEEDANCE_15 = {
    "480p": { off: tokenRate(854, 480, 1.2), on: tokenRate(854, 480, 2.4) },
    "720p": { off: tokenRate(1280, 720, 1.2), on: tokenRate(1280, 720, 2.4) },
    "1080p": { off: tokenRate(1920, 1080, 1.2), on: tokenRate(1920, 1080, 2.4) },
};
const VEO_31 = { "4k": { off: 400_000, on: 600_000 }, "720p": { off: 200_000, on: 400_000 }, "1080p": { off: 200_000, on: 400_000 } };
const VEO_31_FAST = { "4k": { off: 300_000, on: 350_000 }, "720p": { off: 100_000, on: 150_000 }, "1080p": { off: 100_000, on: 150_000 } };
const VEO_3 = { "720p": { off: 200_000, on: 400_000 }, "1080p": { off: 200_000, on: 400_000 } };
const VEO_3_FAST = { "720p": { off: 100_000, on: 150_000 }, "1080p": { off: 100_000, on: 150_000 } };
const KLING_O3_4K = 420_000;
const KLING_V3_4K = 420_000;

/**
 * The verified prices, keyed by `modelApiId`. An endpoint in `FAL_VIDEO_INPUTS` with no entry here must be in
 * `UNPRICED_FAL_VIDEO` (`fal-video-prices.test.ts` holds both to that).
 */
export const FAL_VIDEO_PRICES: Record<string, FalVideoPrice> = {
    // ByteDance Seedance 2.0 (standard, fast). The page prices 720p and 1080p per second; 480p and 4k are the token formula.
    "bytedance/seedance-2.0/fast/image-to-video": { byResolution: SEEDANCE_2_FAST, unit: "second" },
    "bytedance/seedance-2.0/fast/reference-to-video": {
        byResolution: SEEDANCE_2_FAST,
        referenceVideoMultiplier: 0.6,
        unit: "second",
    },
    "bytedance/seedance-2.0/fast/text-to-video": { byResolution: SEEDANCE_2_FAST, unit: "second" },
    "bytedance/seedance-2.0/image-to-video": { byResolution: SEEDANCE_2, unit: "second" },
    "bytedance/seedance-2.0/reference-to-video": { byResolution: SEEDANCE_2, referenceVideoMultiplier: 0.6, unit: "second" },
    "bytedance/seedance-2.0/text-to-video": { byResolution: SEEDANCE_2, unit: "second" },
    // ByteDance Seedance 1.5 Pro: token-priced only, at 2.40 per million tokens with audio and 1.20 without.
    "fal-ai/bytedance/seedance/v1.5/pro/image-to-video": { byResolution: SEEDANCE_15, unit: "second" },
    "fal-ai/bytedance/seedance/v1.5/pro/text-to-video": { byResolution: SEEDANCE_15, unit: "second" },
    // Kling. v2.5 Turbo is 0.35 for 5 s and 0.07 for each further second, so it is linear.
    "fal-ai/kling-video/o1/standard/video-to-video/edit": { fixedSeconds: 10, rate: 126_000, unit: "second" },
    "fal-ai/kling-video/o3/4k/image-to-video": { rate: KLING_O3_4K, unit: "second" },
    "fal-ai/kling-video/o3/4k/reference-to-video": { rate: KLING_O3_4K, unit: "second" },
    "fal-ai/kling-video/o3/4k/text-to-video": { rate: KLING_O3_4K, unit: "second" },
    "fal-ai/kling-video/o3/standard/image-to-video": { rate: { off: 84_000, on: 112_000 }, unit: "second" },
    "fal-ai/kling-video/v1.5/pro/image-to-video": { rate: 100_000, unit: "second" },
    "fal-ai/kling-video/v1.5/pro/text-to-video": { rate: 100_000, unit: "second" },
    "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": { rate: 70_000, unit: "second" },
    "fal-ai/kling-video/v2.5-turbo/pro/text-to-video": { rate: 70_000, unit: "second" },
    "fal-ai/kling-video/v3/4k/image-to-video": { rate: KLING_V3_4K, unit: "second" },
    "fal-ai/kling-video/v3/4k/text-to-video": { rate: KLING_V3_4K, unit: "second" },
    "fal-ai/kling-video/v3/pro/image-to-video": { rate: { off: 112_000, on: 168_000 }, unit: "second" },
    // Lightricks LTX, Luma Dream Machine (per clip; Ray 2 per 5 s, doubled at 720p and quadrupled at 1080p).
    "fal-ai/ltx-video": { rate: 20_000, unit: "video" },
    "fal-ai/luma-dream-machine": { rate: 500_000, unit: "video" },
    "fal-ai/luma-dream-machine/image-to-video": { rate: 500_000, unit: "video" },
    "fal-ai/luma-dream-machine/ray-2": { blockSeconds: 5, byResolution: { "540p": 500_000, "720p": 1_000_000, "1080p": 2_000_000 }, unit: "block" },
    // MiniMax Hailuo. The 02 Pro endpoint makes one 6 s clip (no duration input).
    "fal-ai/minimax/hailuo-02/pro/image-to-video": { fixedSeconds: 6, rate: 480_000, unit: "video" },
    "fal-ai/minimax/hailuo-02/pro/text-to-video": { fixedSeconds: 6, rate: 480_000, unit: "video" },
    // The 02 Standard page gives 768P at 0.045 per second; 512P is only "roughly 0.017", so it is charged the 768P rate.
    "fal-ai/minimax/hailuo-02/standard/image-to-video": { byResolution: { "512P": 45_000, "768P": 45_000 }, unit: "second" },
    "fal-ai/minimax/hailuo-02/standard/text-to-video": { rate: 45_000, unit: "second" },
    "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video": { byDuration: { 6: 190_000, 10: 320_000 }, unit: "video" },
    "fal-ai/minimax/hailuo-2.3/pro/image-to-video": { rate: 490_000, unit: "video" },
    "fal-ai/minimax/hailuo-2.3/pro/text-to-video": { rate: 490_000, unit: "video" },
    "fal-ai/minimax/hailuo-2.3/standard/image-to-video": { byDuration: { 6: 280_000, 10: 560_000 }, unit: "video" },
    "fal-ai/minimax/hailuo-2.3/standard/text-to-video": { byDuration: { 6: 280_000, 10: 560_000 }, unit: "video" },
    "fal-ai/minimax/video-01": { fixedSeconds: 6, rate: 500_000, unit: "video" },
    "fal-ai/minimax/video-01-live": { fixedSeconds: 6, rate: 500_000, unit: "video" },
    "fal-ai/minimax/video-01-live/image-to-video": { fixedSeconds: 6, rate: 500_000, unit: "video" },
    // Pika v2.2: one price per clip at each resolution.
    "fal-ai/pika/v2.2/image-to-video": { byResolution: { "720p": 200_000, "1080p": 450_000 }, unit: "video" },
    "fal-ai/pika/v2.2/text-to-video": { byResolution: { "720p": 200_000, "1080p": 450_000 }, unit: "video" },
    "fal-ai/stable-video": { rate: 75_000, unit: "video" },
    // Google Veo. Veo 3 and 3.1 are priced by audio and, for 3.1, 4k. Veo 3.1 Fast reference-to-video states no 4k rate: the fast family's 4k rate is used.
    "fal-ai/veo2": { rate: 500_000, unit: "second" },
    "fal-ai/veo2/image-to-video": { rate: 500_000, unit: "second" },
    "fal-ai/veo3": { byResolution: VEO_3, unit: "second" },
    "fal-ai/veo3.1": { byResolution: VEO_31, unit: "second" },
    "fal-ai/veo3.1/fast": { byResolution: VEO_31_FAST, unit: "second" },
    "fal-ai/veo3.1/fast/image-to-video": { byResolution: VEO_31_FAST, unit: "second" },
    "fal-ai/veo3.1/fast/reference-to-video": { byResolution: VEO_31_FAST, unit: "second" },
    "fal-ai/veo3.1/image-to-video": { byResolution: VEO_31, unit: "second" },
    "fal-ai/veo3.1/reference-to-video": { byResolution: VEO_31, unit: "second" },
    "fal-ai/veo3/fast": { byResolution: VEO_3_FAST, unit: "second" },
    "fal-ai/veo3/fast/image-to-video": { byResolution: VEO_3_FAST, unit: "second" },
    "fal-ai/veo3/image-to-video": { byResolution: VEO_3, unit: "second" },
    // Google Gemini Omni (reference-to-video): priced per second by resolution.
    "google/gemini-omni-flash/v1.1/reference-to-video": {
        byResolution: { "4k": 300_000, "360p": 30_000, "720p": 100_000, "1080p": 150_000 },
        unit: "second",
    },
    // xAI Grok Imagine: per second by resolution, plus a charge per image sent (the start frame).
    "xai/grok-imagine-video/v1.5/image-to-video": {
        byResolution: { "480p": 80_000, "720p": 140_000, "1080p": 250_000 },
        perImage: 10_000,
        unit: "second",
    },
};

/**
 * Enabled video endpoints the workflow cannot bill yet, keyed by `modelApiId`, with the reason. Empty now: the three
 * endpoints whose pages state no price are disabled in the registry instead. A new row without a price goes here, or
 * the drift test in `backend/lunora/workflow/video-policy.test.ts` fails.
 */
export const UNPRICED_FAL_VIDEO: Record<string, string> = {};

/** The endpoint's verified price, or `undefined` for an endpoint with none (see `UNPRICED_FAL_VIDEO`). */
export const falVideoPriceOf = (modelApiId: string | undefined): FalVideoPrice | undefined =>
    modelApiId === undefined ? undefined : FAL_VIDEO_PRICES[modelApiId];

/** The clip length of an endpoint that takes no `duration`, when its page fixes one. `undefined` otherwise. */
export const falVideoFixedSecondsOf = (modelApiId: string | undefined): number | undefined => falVideoPriceOf(modelApiId)?.fixedSeconds;

/**
 * What one clip costs in microdollars, from the options it is sent (the same ones `falVideoOptionInput` yields),
 * the length billed, and what else the call carries. Options the endpoint does not take fall back to its own
 * defaults (`resolution`, `audioDefault`), so the price is the one fal charges for the request it receives.
 * `undefined` for an unpriced endpoint.
 */
export const falVideoMicrodollarsOf = (modelApiId: string | undefined, input: FalVideoBillingInput): number | undefined => {
    const price = falVideoPriceOf(modelApiId);

    if (!price) {
        return undefined;
    }

    const spec = falVideoInputsOf(modelApiId);
    const options = snapVideoOptions(modelApiId, input.options);
    const resolution = options.resolution ?? spec?.resolution?.default;
    const audio = options.generateAudio ?? spec?.audioDefault ?? undefined;
    const seconds = price.fixedSeconds ?? input.seconds;
    const rate = price.byResolution ? resolutionRate(price.byResolution, resolution, audio) : rateFor(price.rate ?? 0, audio);

    let amount: number;

    if (price.byDuration) {
        amount = durationPrice(price.byDuration, seconds);
    } else if (price.unit === "block") {
        amount = Math.ceil(seconds / (price.blockSeconds ?? 1)) * rate;
    } else if (price.unit === "second") {
        amount = Math.round(seconds * rate);

        if (input.referenceSeconds > 0 && price.referenceVideoMultiplier !== undefined) {
            // Rounded to the nearest microdollar: a multiple computed in floats must not gain a microdollar, and so a credit.
            amount = Math.round(price.referenceVideoMultiplier * rate * (seconds + input.referenceSeconds));
        }
    } else {
        amount = rate;
    }

    return amount + (price.perImage ?? 0) * input.images;
};
