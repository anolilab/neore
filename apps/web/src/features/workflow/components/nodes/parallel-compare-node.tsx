import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Columns, Plus, X } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { ParallelCompareNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const MAX_MODELS = 4;
const MIN_MODELS = 2;

// Stable identity for the empty case: a fresh `[]` per render would change on
// every redraw and invalidate every memo that depends on the selection.
const NO_MODELS: string[] = [];

const ParallelCompareNodeComponent = (props: NodeProps<Node<ParallelCompareNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["parallel-compare"];
    const models = useFeatureFlaggedModels();
    const { t } = useLingui();

    const modelOptions = models.flatMap((m) => (m.enabled && m.filterCapabilities?.includes("image_generation") ? [toBaseOption(m)] : []));

    const selectedModels = data.models ?? NO_MODELS;

    // Get available models (not already selected)
    const selectedModelSet = new Set(selectedModels);
    const availableModels = modelOptions.filter((m) => !selectedModelSet.has(m.value));

    const handleAddModel = () => {
        if (selectedModels.length >= MAX_MODELS) {
            return;
        }

        const nextModel = availableModels[0];

        if (nextModel) {
            updateNode(id, { models: [...selectedModels, nextModel.value] });
        }
    };

    const handleRemoveModel = (index: number) => {
        if (selectedModels.length <= MIN_MODELS) {
            return;
        }

        const newModels = selectedModels.filter((_, i) => i !== index);

        updateNode(id, { models: newModels });
    };

    const handleModelChange = (index: number, modelId: string) => {
        const newModels = [...selectedModels];

        newModels[index] = modelId;
        updateNode(id, { models: newModels });
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    const handleShowLabelsChange = (showLabels: boolean) => {
        updateNode(id, { showLabels });
    };

    const getModelLabel = (modelId: string) => {
        const model = modelOptions.find((m) => m.value === modelId);

        return model?.label ?? modelId;
    };

    const getModelPremium = (modelId: string) => {
        const model = modelOptions.find((m) => m.value === modelId);

        return model?.isPremium ?? false;
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Columns className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Models to Compare</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">
                            {selectedModels.length}/{MAX_MODELS}
                        </span>
                    </div>

                    <div className="space-y-2">
                        {selectedModels.map((modelId, index) => (
                            <div className="flex items-center gap-2" key={index}>
                                <Select onValueChange={(value) => value !== null && handleModelChange(index, value)} value={modelId}>
                                    <SelectTrigger className="nodrag h-8 flex-1 text-sm">
                                        <SelectValue>
                                            {getModelLabel(modelId)}
                                            {getModelPremium(modelId) && <span className="ml-1 text-xs text-amber-500">★</span>}
                                        </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {/* Show current selection */}
                                        <SelectItem value={modelId}>
                                            {getModelLabel(modelId)}
                                            {getModelPremium(modelId) && <span className="ml-1 text-xs text-amber-500">★</span>}
                                        </SelectItem>
                                        {/* Show available models */}
                                        {availableModels.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                                {option.label}
                                                {option.isPremium && <span className="ml-1 text-xs text-amber-500">★</span>}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {selectedModels.length > MIN_MODELS && (
                                    <Button
                                        aria-label={t`Remove model`}
                                        className="nodrag size-8"
                                        onClick={() => handleRemoveModel(index)}
                                        size="icon"
                                        variant="ghost"
                                    >
                                        <X className="size-4" />
                                    </Button>
                                )}
                            </div>
                        ))}

                        {selectedModels.length < MAX_MODELS && availableModels.length > 0 && (
                            <Button className="nodrag h-8 w-full" onClick={handleAddModel} size="sm" variant="outline">
                                <Plus className="mr-1 size-4" />
                                <Trans>Add Model</Trans>
                            </Button>
                        )}
                    </div>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                        <Trans>Shared Prompt</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`Prompt to run on all models...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Or connect a Text node to provide the prompt</Trans>
                    </p>
                </div>

                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Show Labels</Trans>
                        </Label>
                        <p className="text-muted-foreground text-xs">
                            <Trans>Display model names on results</Trans>
                        </p>
                    </div>
                    <Switch aria-label={t`Show Labels`} checked={data.showLabels ?? true} className="nodrag" onCheckedChange={handleShowLabelsChange} />
                </div>
            </div>
        </BaseNode>
    );
};

const ParallelCompareNode = memo(ParallelCompareNodeComponent);

export default ParallelCompareNode;
