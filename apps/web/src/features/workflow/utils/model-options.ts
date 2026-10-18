import type { GatewayModel, VideoOptions } from "@neore/ai/models";
import { falVideoInputsOf, MODEL_LOOKUP, snapVideoOptions } from "@neore/ai/models";

import type { VideoNodeData } from "../types";

const MODEL_ID_SEPARATOR_RE = /[/:]/;

/**
 * Extract a short display name from a model ID.
 *
 * Examples:
 *   "fal-ai/flux/dev/image-to-image" → "image-to-image"
 *   "fal:flux-dev"                   → "flux-dev"
 *   "claude-opus-4-6"               → "claude-opus-4-6".
 */
export const getShortModelName = (modelId: string): string => modelId.split(MODEL_ID_SEPARATOR_RE).pop() ?? modelId;

/**
 * Resolve a human-readable label for a model ID.
 * Checks the provided model list first, falls back to the short name.
 * `fallback` (already translated) is shown when no model is set.
 */
export const getModelLabel = (modelId: string | undefined, models: GatewayModel[], fallback = "Model"): string => {
    if (!modelId) {
        return fallback;
    }

    const registryModel = models.find((m) => m.id === modelId);

    if (registryModel?.name) {
        return registryModel.name;
    }

    return getShortModelName(modelId);
};

/** Base option shape shared by all workflow node model selects */
export interface BaseModelOption {
    isPremium?: boolean;
    label: string;
    value: string;
}

/**
 * Convert a GatewayModel (or compatible object) to a base { label, value, isPremium } option.
 * Nodes that need extra fields can spread the result and add their own.
 */
export const toBaseOption = (m: { id: string; isPremium?: boolean; name?: string }): BaseModelOption => {
    return {
        isPremium: m.isPremium,
        label: m.name ?? m.id,
        value: m.id,
    };
};

/** The FAL endpoint a registry model calls. The backend keys its per-endpoint video table by it, not by the registry id. */
export const registryApiIdOf = (modelId: string | undefined): string | undefined => (modelId === undefined ? undefined : MODEL_LOOKUP.get(modelId)?.modelApiId);

/**
 * The fields a video node writes when it switches to `modelId`: its audio and resolution, each kept
 * only if the new model still takes it. An option the model lacks is cleared, not carried over.
 */
export const videoModelPatch = (modelId: string, current: VideoOptions): Pick<VideoNodeData, "generateAudio" | "model" | "resolution"> => {
    const kept = snapVideoOptions(registryApiIdOf(modelId), current);

    return { generateAudio: kept.generateAudio, model: modelId, resolution: kept.resolution };
};

export interface ReferenceModeCandidate {
    id: string;
    maxReferenceImages?: number;
    modelApiId: string;
}

export interface ReferenceModeVariant {
    id: string;
    kind: "references" | "start-frame";
}

const FAMILY_SUFFIX = /\/(?:image|reference)-to-video$/u;

/**
 * Two variants of one family for the reference-mode switch: the start-frame endpoint
 * (`image-to-video`) and the reference endpoint (`reference-to-video`). A reference variant counts only
 * when its endpoint takes a reference image array and the registry allows at least one image, so the
 * switch never offers a model the start frame cannot reach. `first-last-frame` variants are never
 * offered: they need two frames.
 *
 * Returns the family's variants in [start frame, references] order, or nothing unless both exist.
 */
export const referenceModeVariants = (
    current: ReferenceModeCandidate | undefined,
    candidates: ReadonlyArray<ReferenceModeCandidate>,
): ReferenceModeVariant[] => {
    if (!current || !FAMILY_SUFFIX.test(current.modelApiId)) {
        return [];
    }

    const family = current.modelApiId.replace(FAMILY_SUFFIX, "");
    const variants: ReferenceModeVariant[] = [];

    for (const candidate of candidates) {
        if (!FAMILY_SUFFIX.test(candidate.modelApiId) || candidate.modelApiId.replace(FAMILY_SUFFIX, "") !== family) {
            continue;
        }

        if (candidate.modelApiId.endsWith("/image-to-video")) {
            variants.push({ id: candidate.id, kind: "start-frame" });
        } else if ((candidate.maxReferenceImages ?? 0) > 0 && falVideoInputsOf(candidate.modelApiId)?.references?.images !== undefined) {
            variants.push({ id: candidate.id, kind: "references" });
        }
    }

    const start = variants.find((variant) => variant.kind === "start-frame");
    const references = variants.find((variant) => variant.kind === "references");

    return start && references ? [start, references] : [];
};
