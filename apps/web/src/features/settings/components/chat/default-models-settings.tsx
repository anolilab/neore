"use client";

import { useLingui } from "@lingui/react/macro";
import {
    DEFAULT_FIRST_LAST_FRAME_TO_VIDEO_MODEL,
    DEFAULT_IMAGE_TO_IMAGE_MODEL,
    DEFAULT_IMAGE_TO_TEXT_MODEL,
    DEFAULT_IMAGE_TO_VIDEO_MODEL,
    DEFAULT_IMAGES_TO_IMAGE_MODEL,
    DEFAULT_IMAGES_TO_VIDEO_MODEL,
    DEFAULT_MIXED_TO_VIDEO_MODEL,
    DEFAULT_TEXT_TO_IMAGE_MODEL,
    DEFAULT_TEXT_TO_TEXT_MODEL,
    DEFAULT_TEXT_TO_VIDEO_MODEL,
    DEFAULT_VIDEO_TO_TEXT_MODEL,
    DEFAULT_VIDEO_TO_VIDEO_MODEL,
} from "@neore/ai/constants";
import type { GatewayModel } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Separator } from "@neore/ui/components/separator";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { toast } from "sonner";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";

type DefaultModels = {
    firstLastFrameToVideo?: string;
    imagesToImage?: string;
    imagesToVideo?: string;
    imageToImage?: string;
    imageToText?: string;
    imageToVideo?: string;
    mixedToVideo?: string;
    textToImage?: string;
    textToText?: string;
    textToVideo?: string;
    videoToText?: string;
    videoToVideo?: string;
};

type DefaultModelKey = keyof DefaultModels;

interface ModelSelectProps {
    description: string;
    disabled?: boolean;
    field: DefaultModelKey;
    label: string;
    models: GatewayModel[];
    onChange: (field: DefaultModelKey, modelId: string | null) => void;
    /** The system fallback model ID shown in the "System default" option */
    systemDefaultId?: string;
    value: string | undefined;
}

const ModelSelect: FC<ModelSelectProps> = ({ description, disabled, field, label, models, onChange, systemDefaultId, value }) => {
    const { t } = useLingui();
    const selectedModel = models.find((m) => m.id === value);
    const allModels = useFeatureFlaggedModels();
    const systemDefaultModel = systemDefaultId ? allModels.find((m) => m.id === systemDefaultId) : undefined;

    const systemDefaultLabel = systemDefaultModel ? systemDefaultModel.name : t`System default`;

    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-0.5">
                <Label className="text-sm font-medium">{label}</Label>
                <p className="text-muted-foreground text-xs">{description}</p>
            </div>
            <Select<string> disabled={disabled || models.length === 0} onValueChange={(v) => onChange(field, v)} value={value ?? null}>
                <SelectTrigger className="w-48 shrink-0">
                    <SelectValue placeholder={models.length === 0 ? t`No models available` : systemDefaultLabel}>
                        {selectedModel && (
                            <span className="flex items-center gap-1.5 truncate">
                                <ProviderIcon
                                    className="size-3 shrink-0"
                                    provider={selectedModel.provider ?? selectedModel.displayProvider ?? ""}
                                    providerIcon={selectedModel.id.split("/", 1)[0] ?? selectedModel.displayProvider ?? ""}
                                />
                                <span className="truncate">{selectedModel.name}</span>
                            </span>
                        )}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent align="end" className="max-h-64">
                    <SelectItem value={null as unknown as string}>
                        {systemDefaultModel ? (
                            <span className="flex items-center gap-1.5">
                                <ProviderIcon
                                    className="size-3 shrink-0"
                                    provider={systemDefaultModel.provider ?? systemDefaultModel.displayProvider ?? ""}
                                    providerIcon={systemDefaultModel.id.split("/", 1)[0] ?? systemDefaultModel.displayProvider ?? ""}
                                />
                                <span className="text-muted-foreground truncate">{systemDefaultModel.name}</span>
                                <span className="text-muted-foreground/60 text-xs">{t`(default)`}</span>
                            </span>
                        ) : (
                            <span className="text-muted-foreground">{t`System default`}</span>
                        )}
                    </SelectItem>
                    {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                            <span className="flex items-center gap-1.5">
                                <ProviderIcon
                                    className="size-3 shrink-0"
                                    provider={m.provider ?? m.displayProvider ?? ""}
                                    providerIcon={m.id.split("/", 1)[0] ?? m.displayProvider ?? ""}
                                />
                                <span className="truncate">{m.name}</span>
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
};

const DefaultModelsSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences, isLoading } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

    // Feature-flag-aware model lists — models behind a disabled flag are hidden
    const flaggedModels = useFeatureFlaggedModels();

    if (isLoading) {
        return <div className="text-muted-foreground text-sm">{t`Loading...`}</div>;
    }

    const defaults = (aiPreferences?.defaultModels ?? {}) as DefaultModels;

    const flaggedIds = new Set(flaggedModels.map((m) => m.id));
    const ff = (list: GatewayModel[]) => list.filter((m) => flaggedIds.has(m.id));

    const textModels = flaggedModels.filter((m) => m.enabled && (m.mode === "text" || !m.mode));
    const visionModels = flaggedModels.filter((m) => m.enabled && (m.mode === "text" || !m.mode) && m.filterCapabilities?.includes("vision"));
    const imageGenModels = ff(flaggedModels.filter((m) => m.enabled && m.filterCapabilities?.includes("image_generation")));
    const img2imgModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsImg2Img));
    const charRefModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsCharacterRef));
    const textToVideoModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsTextToVideo));
    const imageToVideoModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsImageToVideo));
    const videoModels = flaggedModels.filter((m) => m.enabled && m.mode === "video");

    const handleChange = (field: DefaultModelKey, modelId: string | null) => {
        const updated = { ...defaults };

        if (modelId === null) {
            delete updated[field];
        } else {
            updated[field] = modelId;
        }

        updateMutation.mutate(
            { defaultModels: updated },
            {
                onError: () => toast.error(t`Failed to update default model`),
                onSuccess: () => {
                    if (modelId) {
                        trackEvent("default_model_changed", { mode: field, model: modelId });
                    }

                    toast.success(t`Default model updated`);
                },
            },
        );
    };

    const { isPending } = updateMutation;

    return (
        <div className="space-y-6 pb-6">
            {/* Text */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Text`}</CardTitle>
                    <CardDescription>{t`Choose default text models`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ModelSelect
                        description={t`Default model for chat and text generation`}
                        disabled={isPending}
                        field="textToText"
                        label={t`Text to text`}
                        models={textModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_TEXT_TO_TEXT_MODEL}
                        value={defaults.textToText}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for image understanding and analysis`}
                        disabled={isPending}
                        field="imageToText"
                        label={t`Image to text`}
                        models={visionModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGE_TO_TEXT_MODEL}
                        value={defaults.imageToText}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for video understanding and transcription`}
                        disabled={isPending}
                        field="videoToText"
                        label={t`Video to text`}
                        models={textModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_VIDEO_TO_TEXT_MODEL}
                        value={defaults.videoToText}
                    />
                </CardContent>
            </Card>

            {/* Image */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Image`}</CardTitle>
                    <CardDescription>{t`Choose default image models`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ModelSelect
                        description={t`Default model for generating images from text prompts`}
                        disabled={isPending}
                        field="textToImage"
                        label={t`Text to image`}
                        models={imageGenModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_TEXT_TO_IMAGE_MODEL}
                        value={defaults.textToImage}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for transforming existing images`}
                        disabled={isPending}
                        field="imageToImage"
                        label={t`Image to image`}
                        models={img2imgModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGE_TO_IMAGE_MODEL}
                        value={defaults.imageToImage}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for combining multiple reference images`}
                        disabled={isPending}
                        field="imagesToImage"
                        label={t`Images to image`}
                        models={charRefModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGES_TO_IMAGE_MODEL}
                        value={defaults.imagesToImage}
                    />
                </CardContent>
            </Card>

            {/* Video */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Video`}</CardTitle>
                    <CardDescription>{t`Choose default video models`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ModelSelect
                        description={t`Default model for generating video from text prompts`}
                        disabled={isPending}
                        field="textToVideo"
                        label={t`Text to video`}
                        models={textToVideoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_TEXT_TO_VIDEO_MODEL}
                        value={defaults.textToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for animating a single image`}
                        disabled={isPending}
                        field="imageToVideo"
                        label={t`Image to video`}
                        models={imageToVideoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGE_TO_VIDEO_MODEL}
                        value={defaults.imageToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for video generation with start and end frames`}
                        disabled={isPending}
                        field="firstLastFrameToVideo"
                        label={t`First frame / last frame`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_FIRST_LAST_FRAME_TO_VIDEO_MODEL}
                        value={defaults.firstLastFrameToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for generating video from multiple images`}
                        disabled={isPending}
                        field="imagesToVideo"
                        label={t`Images to video`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGES_TO_VIDEO_MODEL}
                        value={defaults.imagesToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for editing or transforming existing video`}
                        disabled={isPending}
                        field="videoToVideo"
                        label={t`Video to video`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_VIDEO_TO_VIDEO_MODEL}
                        value={defaults.videoToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for video generation from mixed inputs`}
                        disabled={isPending}
                        field="mixedToVideo"
                        label={t`Mixed to video`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_MIXED_TO_VIDEO_MODEL}
                        value={defaults.mixedToVideo}
                    />
                </CardContent>
            </Card>
        </div>
    );
};

export default DefaultModelsSettings;
