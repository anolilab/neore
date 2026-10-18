/**
 * The registry row each workflow media kind runs when its node names no model, and the rule each kind's
 * actions accept a stored id by. The web node defaults, the backend executor and actions all read these, so a
 * fresh node, a saved node and the run agree. `workflow-defaults.test.ts` pins every default to a row the
 * kind accepts.
 */
import type { ModelAccepts } from "./enabled-model";
import { FAL_IMAGE, FAL_VIDEO } from "./enabled-model";
import { DEFAULT_SPEECH_MODEL } from "./gateway-models";

export const MEDIA_DEFAULT_MODELS = {
    backgroundRemoval: "fal-ai/birefnet",
    characterRef: "fal-ai/flux-pro-redux",
    controlnet: "fal-ai/controlnet-union",
    image: "fal-ai/recraft/v3/text-to-image",
    imageToVideo: "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video",
    img2img: "fal-ai/flux-pro-redux",
    inpaint: "fal-ai/flux-pro-fill",
    objectRemove: "fal-ai/lama",
    outpaint: "fal-ai/flux-outpaint",
    styleRef: "fal-ai/flux-redux-style",
    textToVideo: "fal-ai/ltx-video",
    transcription: "fal-ai/whisper",
    tts: DEFAULT_SPEECH_MODEL,
    upscale: "fal-ai/creative-upscaler",
} as const;

export type WorkflowModelKind = keyof typeof MEDIA_DEFAULT_MODELS;

/** What each kind's action accepts from a node's stored model id. */
export const WORKFLOW_KIND_ACCEPTS: Record<WorkflowModelKind, ModelAccepts> = {
    backgroundRemoval: { ...FAL_IMAGE, capability: "supportsBackgroundRemoval" },
    characterRef: { ...FAL_IMAGE, capability: "supportsCharacterRef" },
    controlnet: { ...FAL_IMAGE, capability: "supportsControlNet" },
    image: { mode: "image" },
    imageToVideo: { ...FAL_VIDEO, capability: "supportsImageToVideo" },
    img2img: { ...FAL_IMAGE, capability: "supportsImg2Img" },
    inpaint: { ...FAL_IMAGE, capability: "supportsInpaint" },
    objectRemove: { ...FAL_IMAGE, capability: "supportsObjectRemoval" },
    outpaint: { ...FAL_IMAGE, capability: "supportsOutpaint" },
    styleRef: { ...FAL_IMAGE, capability: "supportsStyleRef" },
    textToVideo: { ...FAL_VIDEO, capability: "supportsTextToVideo" },
    transcription: { mode: "speech-to-text", provider: "fal" },
    tts: { mode: "text-to-speech" },
    upscale: { ...FAL_IMAGE, capability: "supportsUpscale" },
};

/** Stored ids that only ever meant one kind's default, keyed by the id. The kind must match the node's. */
export const LEGACY_WORKFLOW_MODELS: ReadonlyMap<string, WorkflowModelKind> = new Map<string, WorkflowModelKind>([
    ["fal-ai/controlnet-sdxl", "controlnet"],
    ["fal-ai/flux-dev", "image"],
    ["fal-ai/flux-dev-img2img", "img2img"],
    ["fal-ai/flux-dev-inpaint", "inpaint"],
    ["fal-ai/flux/dev/image-to-image", "img2img"],
    ["fal-ai/kling-video/v2.1/standard/image-to-video", "imageToVideo"],
    ["fal-ai/mochi-v1", "textToVideo"],
    ["fal:flux-dev", "image"],
    ["fal:flux-schnell", "image"],
    ["fal:mochi-v1", "textToVideo"],
    ["fal:sdxl-lightning", "image"],
    ["openai:tts-1", "tts"],
    ["whisper", "transcription"],
]);

/**
 * The model id a node of `kind` runs: its stored id, its kind's default when unset, or the default for a
 * legacy id. Any other stored id is returned unchanged, and the action's enabled-model check refuses it.
 * Idempotent, so an executor and the action may both resolve the same id.
 */
export const resolveWorkflowModel = (kind: WorkflowModelKind, stored: string | undefined): string => {
    if (!stored) {
        return MEDIA_DEFAULT_MODELS[kind];
    }

    return LEGACY_WORKFLOW_MODELS.get(stored) === kind ? MEDIA_DEFAULT_MODELS[kind] : stored;
};
