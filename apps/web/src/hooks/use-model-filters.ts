"use client";

import type { GatewayModel } from "@neore/ai/models";

import useFeatureFlaggedModels from "./use-feature-flagged-models";

/**
 * Model filter hooks that use the gateway-sourced, country-filtered model list.
 *
 * Each hook filters the gateway models directly — no imported filter functions.
 * All predicates are trivial one-liners inlined here for clarity.
 */

export const useImg2ImgModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsImg2Img);
};

export const useUpscaleModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsUpscale);
};

export const useInpaintModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsInpaint);
};

export const useCharacterRefModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsCharacterRef);
};

export const useStyleRefModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsStyleRef);
};

export const useOutpaintModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsOutpaint);
};

export const useBackgroundRemovalModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsBackgroundRemoval);
};

export const useObjectRemovalModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsObjectRemoval);
};

export const useImageToVideoModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsImageToVideo);
};

export const useTextToVideoModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsTextToVideo);
};

export const useImageGenerationModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.filterCapabilities?.includes("image_generation"));
};

export const useTextModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.mode === "text");
};

export const useTextToSpeechModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.mode === "text-to-speech");
};

export const useSpeechToTextModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.mode === "speech-to-text");
};

export const useModelById = (modelId: string): GatewayModel | undefined => {
    const models = useFeatureFlaggedModels();

    return models.find((m) => m.id === modelId);
};

export const useControlNetModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.supportsControlNet);
};

export const usePreprocessorModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.isPreprocessor);
};

export const usePreprocessorModelsByType = (type: string): GatewayModel[] => {
    const models = useFeatureFlaggedModels();

    return models.filter((m) => m.enabled && m.isPreprocessor && m.preprocessorType === type);
};
