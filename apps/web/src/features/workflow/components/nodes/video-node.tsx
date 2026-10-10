import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Video } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { VideoNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const ASPECT_RATIOS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`16:9 (Landscape)`, value: "16:9" },
    { label: msg`9:16 (Portrait)`, value: "9:16" },
    { label: msg`1:1 (Square)`, value: "1:1" },
    { label: msg`4:3`, value: "4:3" },
    { label: msg`3:4`, value: "3:4" },
    { label: msg`21:9 (Ultrawide)`, value: "21:9" },
];

const VideoNodeComponent = (props: NodeProps<Node<VideoNodeData>>) => {
    const { data, id } = props;
    const { i18n, t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.video;
    const allModels = useFeatureFlaggedModels();

    const isImageToVideo = data.mode === "image-to-video";
    const duration = data.duration ?? 5;
    const motionPercent = Math.round((data.motionStrength ?? 0.5) * 100);

    const filteredModels = isImageToVideo
        ? allModels.filter((m) => m.enabled && m.supportsImageToVideo)
        : allModels.filter((m) => m.enabled && m.supportsTextToVideo);
    const modelOptions = (isImageToVideo ? filteredModels : [{ id: "fal-ai/mochi-v1", isPremium: false, maxVideoDuration: 10 }, ...filteredModels]).map((m) => {
        return {
            ...toBaseOption(m),
            maxDuration: ("maxVideoDuration" in m ? m.maxVideoDuration : undefined) ?? 10,
        };
    });

    const defaultModel = isImageToVideo ? "fal-ai/kling-video/v1.5/pro/image-to-video" : "fal-ai/mochi-v1";

    // Get current model capabilities
    const currentModelDefinition = allModels.find((m) => m.id === (data.model ?? defaultModel));
    const currentModelInfo = {
        maxDuration: currentModelDefinition?.maxVideoDuration ?? 10,
        supportedFps: currentModelDefinition?.supportedFps ?? [24],
    };

    const handleModeChange = (mode: string | null) => {
        if (mode === null) {
            return;
        }

        // Reset model when switching modes
        const newDefaultModel = mode === "image-to-video" ? "fal-ai/kling-video/v1.5/pro/image-to-video" : "fal-ai/mochi-v1";

        updateNode(id, { mode: mode as VideoNodeData["mode"], model: newDefaultModel });
    };

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, { model });
        }
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    const handleDurationChange = (value: number | ReadonlyArray<number>) => {
        const array = Array.isArray(value) ? [...value] : [value];

        updateNode(id, { duration: array[0] });
    };

    const handleAspectRatioChange = (aspectRatio: string | null) => {
        if (aspectRatio === null) {
            return;
        }

        updateNode(id, { aspectRatio });
    };

    const handleFpsChange = (fps: string | null) => {
        if (fps === null) {
            return;
        }

        updateNode(id, { fps: Number(fps) });
    };

    const handleMotionStrengthChange = (value: number | ReadonlyArray<number>) => {
        const array = Array.isArray(value) ? [...value] : [value];

        updateNode(id, { motionStrength: array[0] });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Video className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Mode</Trans>
                    </Label>
                    <Select onValueChange={handleModeChange} value={data.mode}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="text-to-video">
                                <Trans>Text to Video</Trans>
                            </SelectItem>
                            <SelectItem value="image-to-video">
                                <Trans>Image to Video</Trans>
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Model</Trans>
                    </Label>
                    <Select onValueChange={handleModelChange} value={data.model ?? defaultModel}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue placeholder={t`Select model...`} />
                        </SelectTrigger>
                        <SelectContent>
                            {modelOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    <span className="block max-w-[180px] truncate">{option.label}</span>
                                    {option.isPremium && <span className="ml-1 text-xs text-amber-500">★</span>}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                        {isImageToVideo ? <Trans>Motion Prompt</Trans> : <Trans>Video Prompt</Trans>}
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={isImageToVideo ? t`Describe the motion/animation...` : t`Describe the video to generate...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                    {isImageToVideo && (
                        <p className="text-muted-foreground text-xs">
                            <Trans>Connect an image node as input</Trans>
                        </p>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    {!isImageToVideo && (
                        <div className="space-y-1.5">
                            <Label className="text-muted-foreground text-xs">
                                <Trans>Aspect Ratio</Trans>
                            </Label>
                            <Select onValueChange={handleAspectRatioChange} value={data.aspectRatio ?? "16:9"}>
                                <SelectTrigger className="nodrag h-8 text-sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {ASPECT_RATIOS.map((ratio) => (
                                        <SelectItem key={ratio.value} value={ratio.value}>
                                            {i18n._(ratio.label)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Duration: {duration}s</Trans>
                        </Label>
                        <Slider
                            className="nodrag"
                            max={currentModelInfo.maxDuration}
                            min={1}
                            onValueChange={handleDurationChange}
                            step={1}
                            value={[data.duration ?? 5]}
                        />
                    </div>

                    {isImageToVideo && (
                        <div className="space-y-1.5">
                            <Label className="text-muted-foreground text-xs">
                                <Trans>Motion: {motionPercent}%</Trans>
                            </Label>
                            <Slider
                                className="nodrag"
                                max={1}
                                min={0}
                                onValueChange={handleMotionStrengthChange}
                                step={0.1}
                                value={[data.motionStrength ?? 0.5]}
                            />
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">FPS</Label>
                        <Select onValueChange={handleFpsChange} value={String(data.fps ?? 24)}>
                            <SelectTrigger className="nodrag h-8 text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {currentModelInfo.supportedFps.map((fps) => (
                                    <SelectItem key={fps} value={String(fps)}>
                                        <Trans>{fps} fps</Trans>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>
        </BaseNode>
    );
};

const VideoNode = memo(VideoNodeComponent);

export default VideoNode;
