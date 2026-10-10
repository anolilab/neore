import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Expand } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { OutpaintNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const EXPAND_DIRECTIONS = [
    { label: msg`All Directions`, value: "all" },
    { label: msg`Left`, value: "left" },
    { label: msg`Right`, value: "right" },
    { label: msg`Top`, value: "top" },
    { label: msg`Bottom`, value: "bottom" },
] as const satisfies ReadonlyArray<{ label: MessageDescriptor; value: string }>;

const OutpaintNodeComponent = (props: NodeProps<Node<OutpaintNodeData>>) => {
    const { data, id } = props;
    const { i18n, t } = useLingui();
    const expandPixels = data.expandPixels ?? 256;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.outpaint;
    const models = useFeatureFlaggedModels();

    const modelOptions: (ReturnType<typeof toBaseOption> & { supportsNegativePrompt: boolean })[] = [];

    for (const m of models) {
        if (m.enabled && m.supportsOutpaint) {
            modelOptions.push({ ...toBaseOption(m), supportsNegativePrompt: m.supportsNegativePrompt ?? false });
        }
    }

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/flux-outpaint";

    // Check if current model supports negative prompt
    const currentModelSupportsNegative = models.find((m) => m.id === (data.model ?? defaultModel))?.supportsNegativePrompt ?? false;

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, { model });
        }
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    const handleDirectionChange = (expandDirection: string | null) => {
        if (expandDirection === null) {
            return;
        }

        updateNode(id, { expandDirection: expandDirection as OutpaintNodeData["expandDirection"] });
    };

    const handlePixelsChange = (value: number | ReadonlyArray<number>) => {
        const array = Array.isArray(value) ? [...value] : [value];

        updateNode(id, { expandPixels: array[0] });
    };

    const handleNegativePromptChange = (negativePrompt: string) => {
        updateNode(id, { negativePrompt });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Expand className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                        <Trans>Expansion Prompt</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`Describe what to generate in expanded areas...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Direction</Trans>
                        </Label>
                        <Select onValueChange={handleDirectionChange} value={data.expandDirection ?? "all"}>
                            <SelectTrigger className="nodrag h-8 text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {EXPAND_DIRECTIONS.map((direction) => (
                                    <SelectItem key={direction.value} value={direction.value}>
                                        {i18n._(direction.label)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Expand: {expandPixels}px</Trans>
                        </Label>
                        <Slider className="nodrag" max={1024} min={64} onValueChange={handlePixelsChange} step={64} value={[data.expandPixels ?? 256]} />
                    </div>
                </div>

                {currentModelSupportsNegative && (
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs" htmlFor={`${id}-negative`}>
                            <Trans>Negative Prompt (optional)</Trans>
                        </Label>
                        <Input
                            className="nodrag h-8 text-sm"
                            id={`${id}-negative`}
                            onChange={(e) => handleNegativePromptChange(e.target.value)}
                            placeholder={t`What to avoid...`}
                            value={data.negativePrompt ?? ""}
                        />
                    </div>
                )}

                <div className="text-muted-foreground bg-muted/50 rounded p-2 text-xs">
                    <Trans>Connect an image node as input</Trans>
                </div>
            </div>
        </BaseNode>
    );
};

const OutpaintNode = memo(OutpaintNodeComponent);

export default OutpaintNode;
