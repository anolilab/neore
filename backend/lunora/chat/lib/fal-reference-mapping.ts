import { falVideoInputsOf, type ModelDefinition, resolutionWithinFreePlan, snapVideoOptions, type VideoOptions } from "@neore/ai/models";

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

/** The control-image field each ControlNet endpoint takes for each control type, keyed by the registry's `modelApiId`. */
const CONTROLNET_IMAGE_FIELDS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
    [
        "fal-ai/sdxl-controlnet-union",
        new Map([
            ["canny", "canny_image_url"],
            ["depth", "depth_image_url"],
            ["normal", "normal_image_url"],
            ["pose", "openpose_image_url"],
            ["softedge", "teed_image_url"],
        ]),
    ],
]);

/** The control image field for a control type on an endpoint, or `undefined` when the endpoint has none for it. */
export const controlNetImageField = (endpoint: string, controlType: string): string | undefined => CONTROLNET_IMAGE_FIELDS.get(endpoint)?.get(controlType);

/** The mask input an endpoint takes. LaMa names it `mask_image_url`; the inpainting endpoints name it `mask_url`. */
const MASK_FIELDS: ReadonlyMap<string, string> = new Map([["fal-ai/lama", "mask_image_url"]]);

export const falMaskField = (endpoint: string): string => MASK_FIELDS.get(endpoint) ?? "mask_url";

/**
 * The `duration` to send for an endpoint: the number snapped to the nearest value the endpoint
 * accepts, in the format its schema names. `undefined` when the endpoint has no `duration` input
 * (send nothing) or when nothing was asked for. An unverified endpoint gets the number as given.
 */
export const falDurationInput = (modelDefinition: ModelDefinition | undefined, duration: number | undefined): number | string | undefined => {
    if (duration === undefined) {
        return undefined;
    }

    const spec = falVideoInputsOf(modelDefinition?.modelApiId);

    if (!spec) {
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
export const falAcceptsAspectRatio = (modelDefinition: ModelDefinition | undefined): boolean =>
    falVideoInputsOf(modelDefinition?.modelApiId)?.aspectRatio ?? true;

/**
 * The `generate_audio` and `resolution` fields to send for an endpoint, snapped by
 * `snapVideoOptions`. A free plan (`premium` false) is held to 1080p. Empty when the endpoint takes
 * neither, so it can be spread unconditionally.
 */
export const falVideoOptionInput = (
    modelDefinition: ModelDefinition | undefined,
    options: VideoOptions,
    premium: boolean,
): { generate_audio?: boolean; resolution?: string } => {
    const snapped = snapVideoOptions(modelDefinition?.modelApiId, options);
    const resolution =
        snapped.resolution === undefined || premium ? snapped.resolution : resolutionWithinFreePlan(modelDefinition?.modelApiId, snapped.resolution);

    return {
        ...(snapped.generateAudio !== undefined && { generate_audio: snapped.generateAudio }),
        ...(resolution !== undefined && { resolution }),
    };
};

/**
 * The most seconds of reference video a model takes in total, or `undefined` when there is no
 * such limit to check. A pre-run check only: the endpoint enforces its own limits too.
 */
export const referenceVideoLimitSeconds = (modelDefinition: ModelDefinition | undefined): number | undefined => {
    if (!modelDefinition || !modelDefinition.maxReferenceVideos) {
        return undefined;
    }

    return falVideoInputsOf(modelDefinition.modelApiId)?.references?.totalSeconds;
};

/**
 * Build the FAL input fragment for the start frame and reference videos and audio, clamped to
 * the model's `maxReferenceImages` / `maxReferenceVideos` / `maxReferenceAudios`. Modalities the
 * endpoint cannot take are dropped, as the image helper does. The start frame leads the image
 * array when the endpoint has one and the registry allows images; otherwise it goes to the
 * endpoint's start-image field (`image_url` unless the table names another). With no model (an
 * unknown id) only the start frame is sent, as `image_url`.
 * @returns object to spread into the FAL input. Empty when nothing applies.
 */
export const buildFalReferenceVideoInput = (
    modelDefinition: ModelDefinition | undefined,
    references: {
        referenceAudioUrls?: ReadonlyArray<string>;
        referenceVideoUrls?: ReadonlyArray<string>;
        /** Image-to-video start frame. */
        startFrameUrl?: string;
    },
): Record<string, string | string[]> => {
    const spec = falVideoInputsOf(modelDefinition?.modelApiId);
    const fields = spec?.references ?? {};
    const result: Record<string, string | string[]> = {};

    if (references.startFrameUrl) {
        if (fields.images && (modelDefinition?.maxReferenceImages ?? 0) > 0) {
            result[fields.images] = [references.startFrameUrl];
        } else {
            result[spec?.startImage ?? "image_url"] = references.startFrameUrl;
        }
    }

    const place = (field: string | undefined, urls: ReadonlyArray<string> | undefined, cap: number | undefined) => {
        if (!field || !urls || urls.length === 0 || !cap || cap <= 0) {
            return;
        }

        result[field] = urls.slice(0, cap);
    };

    place(fields.videos, references.referenceVideoUrls, modelDefinition?.maxReferenceVideos);
    place(fields.audios, references.referenceAudioUrls, modelDefinition?.maxReferenceAudios);

    return result;
};
