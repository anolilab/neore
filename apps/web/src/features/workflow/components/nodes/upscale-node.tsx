import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import type { Node, NodeProps } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { UpscaleNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const UpscaleNodeComponent = (props: NodeProps<Node<UpscaleNodeData>>) => {
    const { data, id } = props;
    const { t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.upscale;
    const models = useFeatureFlaggedModels();

    const modelOptions = [];

    for (const m of models) {
        if (m.enabled && m.supportsUpscale) {
            modelOptions.push({
                ...toBaseOption(m),
                supportsFaceEnhance: m.supportsFaceEnhance ?? false,
                upscaleFactors: m.upscaleFactors ?? [2, 4],
            });
        }
    }

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/creative-upscaler";

    // Get current model's capabilities
    const currentModelDefinition = models.find((m) => m.id === (data.model ?? defaultModel));
    const currentModel = {
        supportsFaceEnhance: currentModelDefinition?.supportsFaceEnhance ?? false,
        upscaleFactors: currentModelDefinition?.upscaleFactors ?? [2, 4],
    };

    const scaleOptions = currentModel.upscaleFactors.map((factor) => {
        return {
            label: `${factor}x`,
            value: String(factor),
        };
    });

    const handleModelChange = (model: string | null) => {
        if (!model) {
            return;
        }

        // Reset scale if new model doesn't support current scale
        const newModelDef = models.find((m) => m.id === model);
        const newFactors = newModelDef?.upscaleFactors ?? [2, 4];
        const currentScale = data.scale ?? 2;

        if (newFactors.includes(currentScale)) {
            updateNode(id, { model });
        } else {
            updateNode(id, { model, scale: newFactors[0] as 2 | 4 });
        }
    };

    const handleScaleChange = (scale: string | null) => {
        if (scale) {
            updateNode(id, { scale: Number(scale) as 2 | 4 });
        }
    };

    const handleEnhanceFaceChange = (enhanceFace: boolean) => {
        updateNode(id, { enhanceFace });
    };

    const handleEnhanceDetailsChange = (enhanceDetails: boolean) => {
        updateNode(id, { enhanceDetails });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Maximize2 className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
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
                                    {option.label}
                                    {option.isPremium && <span className="ml-1 text-xs text-amber-500">★</span>}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Scale Factor</Trans>
                    </Label>
                    <Select onValueChange={handleScaleChange} value={String(data.scale ?? 2)}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {scaleOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {currentModel.supportsFaceEnhance && (
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Enhance Faces</Trans>
                        </Label>
                        <Switch
                            aria-label={t`Enhance Faces`}
                            checked={data.enhanceFace ?? false}
                            className="nodrag"
                            onCheckedChange={handleEnhanceFaceChange}
                        />
                    </div>
                )}

                <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Enhance Details</Trans>
                    </Label>
                    <Switch
                        aria-label={t`Enhance Details`}
                        checked={data.enhanceDetails ?? true}
                        className="nodrag"
                        onCheckedChange={handleEnhanceDetailsChange}
                    />
                </div>
            </div>
        </BaseNode>
    );
};

const UpscaleNode = memo(UpscaleNodeComponent);

export default UpscaleNode;
