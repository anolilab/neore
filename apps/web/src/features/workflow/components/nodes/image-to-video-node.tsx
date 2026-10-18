import { Trans, useLingui } from "@lingui/react/macro";
import { resolveWorkflowModel } from "@neore/ai/models";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Film } from "lucide-react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { ImageToVideoNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption, videoModelPatch } from "../../utils/model-options";
import BaseNode from "./base-node";
import ModelSelect from "./model-select";
import { VideoFramesSection } from "./video-frames-section";
import { ReferenceMode, VideoModelOptions } from "./video-model-options";

const ImageToVideoNode = (props: NodeProps<Node<ImageToVideoNodeData>>) => {
    const { data, id } = props;
    const { t } = useLingui();
    const duration = data.duration ?? 5;
    const motionPercent = Math.round((data.motionStrength ?? 0.5) * 100);
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["image-to-video"];
    const models = useFeatureFlaggedModels();

    const modelOptions = models.flatMap((m) =>
        m.enabled && m.supportsImageToVideo
            ? [
                  {
                      ...toBaseOption(m),
                      maxDuration: m.maxVideoDuration ?? 10,
                      supportedFps: m.supportedFps ?? [24],
                  },
              ]
            : [],
    );

    // Get current model capabilities
    const currentModelDefinition = models.find((m) => m.id === resolveWorkflowModel("imageToVideo", data.model));
    const currentModelInfo = {
        maxDuration: currentModelDefinition?.maxVideoDuration ?? 10,
        supportedFps: currentModelDefinition?.supportedFps ?? [24],
    };

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, videoModelPatch(model, data));
        }
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    const handleDurationChange = (value: number | ReadonlyArray<number>) => {
        const array = Array.isArray(value) ? [...value] : [value];

        updateNode(id, { duration: array[0] });
    };

    const handleMotionStrengthChange = (value: number | ReadonlyArray<number>) => {
        const array = Array.isArray(value) ? [...value] : [value];

        updateNode(id, { motionStrength: array[0] });
    };

    const handleFpsChange = (fps: string | null) => {
        if (fps === null) {
            return;
        }

        updateNode(id, { fps: Number(fps) });
    };

    const handleLoopChange = (loop: boolean) => {
        updateNode(id, { loop });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Film className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <ModelSelect
                        label={<Trans>Model</Trans>}
                        note={<Trans>Pro models need a Pro plan. On a free plan the run stops before it starts.</Trans>}
                        onChange={handleModelChange}
                        options={modelOptions}
                        placeholder={t`Select model...`}
                        value={resolveWorkflowModel("imageToVideo", data.model)}
                    />
                </div>

                <ReferenceMode data={data} id={id} modelId={resolveWorkflowModel("imageToVideo", data.model)} models={models} />

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                        <Trans>Motion Prompt</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`Describe the motion/animation...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Describe how the image should animate</Trans>
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <VideoModelOptions data={data} id={id} modelId={resolveWorkflowModel("imageToVideo", data.model)} />

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

                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Motion: {motionPercent}%</Trans>
                        </Label>
                        <Slider className="nodrag" max={1} min={0} onValueChange={handleMotionStrengthChange} step={0.1} value={[data.motionStrength ?? 0.5]} />
                    </div>
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

                    <div className="flex items-center justify-between pt-5">
                        <Label className="text-muted-foreground text-xs" htmlFor={`${id}-loop`}>
                            <Trans>Seamless Loop</Trans>
                        </Label>
                        <Switch checked={data.loop ?? false} className="nodrag" id={`${id}-loop`} onCheckedChange={handleLoopChange} />
                    </div>
                </div>

                <div className="text-muted-foreground bg-muted/50 rounded p-2 text-xs">
                    <Trans>Connect an image node as input</Trans>
                </div>

                <VideoFramesSection nodeId={id} pickedTime={data.pickedTime} />
            </div>
        </BaseNode>
    );
};

export default ImageToVideoNode;
