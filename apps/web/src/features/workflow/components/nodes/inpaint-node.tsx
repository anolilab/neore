import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Eraser } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useUpstreamImageUrl } from "../../hooks/use-upstream-image-url";
import { useWorkflowStore } from "../../stores/workflow-store";
import type { InpaintNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";
import MaskSection from "./mask-section";

const InpaintNodeComponent = (props: NodeProps<Node<InpaintNodeData>>) => {
    const { data, id } = props;
    const { t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.inpaint;

    const inputImageUrl = useUpstreamImageUrl(id);
    const models = useFeatureFlaggedModels();

    const modelOptions = models.flatMap((m) =>
        m.enabled && m.supportsInpaint
            ? [
                  {
                      ...toBaseOption(m),
                      supportsNegativePrompt: m.supportsNegativePrompt ?? false,
                  },
              ]
            : [],
    );

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/flux-pro-fill";

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

    const handleMaskUrlChange = (maskUrl: string) => {
        updateNode(id, { maskUrl });
    };

    const handleNegativePromptChange = (negativePrompt: string) => {
        updateNode(id, { negativePrompt });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Eraser className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                        <Trans>Fill Prompt</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`What to generate in the masked area...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-mask`}>
                        <Trans>Mask URL (optional)</Trans>
                    </Label>
                    <Input
                        className="nodrag h-8 text-sm"
                        id={`${id}-mask`}
                        onChange={(e) => handleMaskUrlChange(e.target.value)}
                        placeholder={t`https://... (white = edit, black = keep)`}
                        value={data.maskUrl ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Connect mask from upstream node or provide URL</Trans>
                    </p>

                    <MaskSection imageUrl={inputImageUrl} maskUrl={data.maskUrl} onMaskChange={(url) => updateNode(id, { maskUrl: url })} />
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
            </div>
        </BaseNode>
    );
};

const InpaintNode = memo(InpaintNodeComponent);

export default InpaintNode;
