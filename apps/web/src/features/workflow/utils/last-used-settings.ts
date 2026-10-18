import type { WorkflowModelKind } from "@neore/ai/models";
import { enabledModelOf, MEDIA_DEFAULT_MODELS, WORKFLOW_KIND_ACCEPTS } from "@neore/ai/models";

import type {
    AdvancedControlsNodeData,
    AINodeData,
    AudioNodeData,
    BackgroundRemovalNodeData,
    CharacterRefNodeData,
    ControlNetNodeData,
    ImageNodeData,
    ImageToVideoNodeData,
    Img2ImgNodeData,
    InpaintNodeData,
    ObjectEditorNodeData,
    OutpaintNodeData,
    ParallelCompareNodeData,
    StyleRefNodeData,
    TranscriptionNodeData,
    UpscaleNodeData,
    VideoNodeData,
    WorkflowNode,
    WorkflowNodeData,
    WorkflowNodeType,
} from "../types";

/**
 * Settings a new generator node inherits from the last node of its type on the
 * canvas. An allowlist on purpose: prompts, media, status, results and `mode`
 * (which changes what the node takes as input) are never listed, so a field
 * added later is not copied until someone decides it is a setting.
 */
const LAST_USED_KEYS: Partial<Record<WorkflowNodeType, ReadonlyArray<string>>> = {
    "advanced-controls": ["cfgScale", "clipSkip", "sampler", "scheduler", "steps", "useRandomSeed"] satisfies ReadonlyArray<keyof AdvancedControlsNodeData>,
    ai: ["model", "maxTokens", "temperature", "reasoningEffort", "enabledFeatures"] satisfies ReadonlyArray<keyof AINodeData>,
    audio: ["model", "voice"] satisfies ReadonlyArray<keyof AudioNodeData>,
    "background-removal": ["model", "outputFormat", "refineMask", "backgroundColor"] satisfies ReadonlyArray<keyof BackgroundRemovalNodeData>,
    "character-ref": ["model", "strength"] satisfies ReadonlyArray<keyof CharacterRefNodeData>,
    controlnet: ["model", "controlType", "strength", "startPercent", "endPercent", "preprocessor"] satisfies ReadonlyArray<keyof ControlNetNodeData>,
    image: ["model", "aspectRatio", "numImages"] satisfies ReadonlyArray<keyof ImageNodeData>,
    "image-to-video": ["model", "duration", "fps", "motionStrength", "loop", "generateAudio", "resolution"] satisfies ReadonlyArray<keyof ImageToVideoNodeData>,
    img2img: ["model", "strength"] satisfies ReadonlyArray<keyof Img2ImgNodeData>,
    inpaint: ["model"] satisfies ReadonlyArray<keyof InpaintNodeData>,
    "object-editor": ["model"] satisfies ReadonlyArray<keyof ObjectEditorNodeData>,
    outpaint: ["model", "expandDirection", "expandPixels"] satisfies ReadonlyArray<keyof OutpaintNodeData>,
    "parallel-compare": ["models", "aspectRatio", "showLabels"] satisfies ReadonlyArray<keyof ParallelCompareNodeData>,
    "style-ref": ["model", "strength", "preserveContent"] satisfies ReadonlyArray<keyof StyleRefNodeData>,
    transcription: ["model", "language"] satisfies ReadonlyArray<keyof TranscriptionNodeData>,
    upscale: ["model", "scale", "enhanceDetails", "enhanceFace"] satisfies ReadonlyArray<keyof UpscaleNodeData>,
    video: ["model", "aspectRatio", "duration", "fps", "motionStrength", "generateAudio", "resolution"] satisfies ReadonlyArray<keyof VideoNodeData>,
};

/**
 * The media kind a new node of `type` runs, as the video actions read it: an image-to-video node, or a video
 * node whose mode (`next`, the new node's own data) is image-to-video. `undefined` for any other node.
 */
const newVideoKindOf = (type: WorkflowNodeType, next: Partial<WorkflowNodeData>): WorkflowModelKind | undefined => {
    if (type === "image-to-video") {
        return "imageToVideo";
    }

    if (type === "video") {
        return (next as Partial<VideoNodeData>).mode === "image-to-video" ? "imageToVideo" : "textToVideo";
    }

    return undefined;
};

/**
 * The settings for a new node of `type`, taken from the most recently added node
 * of that type. Array order is an approximation of recency: grouping can reorder it.
 *
 * A copied model must take the mode the new node runs in: an image-only model copied into a text-to-video node is
 * not in its picker and cannot get its image. A model the new mode does not take falls back to that mode's default.
 */
export const lastUsedSettings = (
    nodes: ReadonlyArray<WorkflowNode>,
    type: WorkflowNodeType,
    next: Partial<WorkflowNodeData> = {},
): Partial<WorkflowNodeData> => {
    const keys = LAST_USED_KEYS[type];
    const source = keys ? nodes.findLast((node) => node.type === type) : undefined;
    const settings: Record<string, unknown> = {};

    if (keys && source) {
        for (const key of keys) {
            const value = source.data[key];

            if (value !== undefined) {
                // Copy arrays so the new node does not share a list with the old one.
                settings[key] = Array.isArray(value) ? [...value] : value;
            }
        }
    }

    const kind = newVideoKindOf(type, next);
    const model = settings.model as string | undefined;

    // An image-to-video node with nothing copied would otherwise get a video node's text-to-video default.
    if (kind !== undefined && (model === undefined ? kind === "imageToVideo" : !enabledModelOf(model, WORKFLOW_KIND_ACCEPTS[kind]))) {
        settings.model = MEDIA_DEFAULT_MODELS[kind];
    }

    return settings as Partial<WorkflowNodeData>;
};
