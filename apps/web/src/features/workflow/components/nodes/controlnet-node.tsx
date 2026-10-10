import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import type { Node, NodeProps } from "@xyflow/react";
import { Target } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { ControlNetNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const CONTROL_TYPES = [
    { description: msg`Human pose & skeleton`, label: msg`Pose Detection`, value: "pose" },
    { description: msg`3D depth estimation`, label: msg`Depth Map`, value: "depth" },
    { description: msg`Edge detection`, label: msg`Canny Edge`, value: "canny" },
    { description: msg`Surface normals`, label: msg`Normal Map`, value: "normal" },
    { description: msg`Soft edge detection`, label: msg`Soft Edge`, value: "softedge" },
] as const satisfies ReadonlyArray<{ description: MessageDescriptor; label: MessageDescriptor; value: string }>;

type ControlType = ControlNetNodeData["controlType"];

const ControlNetNodeComponent = (props: NodeProps<Node<ControlNetNodeData>>) => {
    const { data, id } = props;
    const { i18n, t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.controlnet;
    const models = useFeatureFlaggedModels();

    const controlNetModels = models.flatMap((m) =>
        m.enabled && m.supportsControlNet
            ? [
                  {
                      ...toBaseOption(m),
                      controlTypes: m.controlNetTypes ?? [],
                  },
              ]
            : [],
    );

    const preprocessorModels = models.flatMap((m) => (m.enabled && m.isPreprocessor && m.preprocessorType === data.controlType ? [toBaseOption(m)] : []));

    const defaultModel = controlNetModels[0]?.value ?? "fal-ai/controlnet-sdxl";
    const defaultPreprocessor = preprocessorModels[0]?.value;

    const handleControlTypeChange = (controlType: string | null) => {
        if (!controlType) {
            return;
        }

        // Reset preprocessor when control type changes
        const newPreprocessor = models.find((m) => m.enabled && m.isPreprocessor && m.preprocessorType === controlType);

        updateNode(id, {
            controlType: controlType as ControlType,
            preprocessor: newPreprocessor?.id,
        });
    };

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, { model });
        }
    };

    const handlePreprocessorChange = (preprocessor: string | null) => {
        if (preprocessor) {
            updateNode(id, { preprocessor });
        }
    };

    const handleStrengthChange = (value: number | ReadonlyArray<number>) => {
        const values = Array.isArray(value) ? value : [value];

        updateNode(id, { strength: values[0] });
    };

    const handleReferenceImageChange = (referenceImageUrl: string) => {
        updateNode(id, { referenceImageUrl });
    };

    const handleStartPercentChange = (value: number | ReadonlyArray<number>) => {
        const values = Array.isArray(value) ? value : [value];

        updateNode(id, { startPercent: values[0] });
    };

    const handleEndPercentChange = (value: number | ReadonlyArray<number>) => {
        const values = Array.isArray(value) ? value : [value];

        updateNode(id, { endPercent: values[0] });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Target className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                {/* Control Type */}
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Control Type</Trans>
                    </Label>
                    <Select onValueChange={handleControlTypeChange} value={data.controlType}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {CONTROL_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                    <div className="flex flex-col">
                                        <span>{i18n._(type.label)}</span>
                                        <span className="text-muted-foreground text-xs">{i18n._(type.description)}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* ControlNet Model */}
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>ControlNet Model</Trans>
                    </Label>
                    <Select onValueChange={handleModelChange} value={data.model ?? defaultModel}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue placeholder={t`Select model...`} />
                        </SelectTrigger>
                        <SelectContent>
                            {controlNetModels.map((option: { isPremium?: boolean; label: string; value: string }) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                    {option.isPremium && <span className="ml-1 text-xs text-amber-500">★</span>}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Preprocessor Model */}
                {preprocessorModels.length > 0 && (
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Preprocessor</Trans>
                        </Label>
                        <Select onValueChange={handlePreprocessorChange} value={data.preprocessor ?? defaultPreprocessor}>
                            <SelectTrigger className="nodrag h-8 text-sm">
                                <SelectValue placeholder={t`Auto-detect`} />
                            </SelectTrigger>
                            <SelectContent>
                                {preprocessorModels.map((option: { label: string; value: string }) => (
                                    <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {/* Reference Image URL */}
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-ref-image`}>
                        <Trans>Reference Image (optional)</Trans>
                    </Label>
                    <Input
                        className="nodrag h-8 text-sm"
                        id={`${id}-ref-image`}
                        onChange={(e) => handleReferenceImageChange(e.target.value)}
                        placeholder={t`https://... or from input`}
                        value={data.referenceImageUrl ?? ""}
                    />
                    {data.referenceImageUrl && (
                        <div className="mt-2 overflow-hidden rounded-md border">
                            <img alt={t`Reference`} className="max-h-[80px] w-full object-contain" src={data.referenceImageUrl} />
                        </div>
                    )}
                </div>

                {/* Strength Slider */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Control Strength</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{((data.strength ?? 0.8) * 100).toFixed(0)}%</span>
                    </div>
                    <Slider className="nodrag" max={1} min={0} onValueChange={handleStrengthChange} step={0.05} value={[data.strength ?? 0.8]} />
                </div>

                {/* Control Timing */}
                <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Control Timing</Trans>
                    </Label>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground text-[10px]">
                                    <Trans>Start</Trans>
                                </span>
                                <span className="text-muted-foreground text-[10px]">{((data.startPercent ?? 0) * 100).toFixed(0)}%</span>
                            </div>
                            <Slider className="nodrag" max={1} min={0} onValueChange={handleStartPercentChange} step={0.05} value={[data.startPercent ?? 0]} />
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground text-[10px]">
                                    <Trans>End</Trans>
                                </span>
                                <span className="text-muted-foreground text-[10px]">{((data.endPercent ?? 1) * 100).toFixed(0)}%</span>
                            </div>
                            <Slider className="nodrag" max={1} min={0} onValueChange={handleEndPercentChange} step={0.05} value={[data.endPercent ?? 1]} />
                        </div>
                    </div>
                    <p className="text-muted-foreground text-[10px]">
                        <Trans>Control when the ControlNet influence applies during generation</Trans>
                    </p>
                </div>
            </div>
        </BaseNode>
    );
};

const ControlNetNode = memo(ControlNetNodeComponent);

export default ControlNetNode;
