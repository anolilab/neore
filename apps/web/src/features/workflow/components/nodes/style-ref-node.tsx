import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Palette } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { StyleRefNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const StyleRefNodeComponent = (props: NodeProps<Node<StyleRefNodeData>>) => {
    const { data, id } = props;
    const { t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["style-ref"];
    const models = useFeatureFlaggedModels();

    const modelOptions = models.flatMap((m) =>
        m.enabled && m.supportsStyleRef
            ? [
                  {
                      ...toBaseOption(m),
                      maxImages: m.maxReferenceImages ?? 1,
                      strengthRange: [0, 1] as readonly [number, number],
                      supportsWeight: false,
                  },
              ]
            : [],
    );

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/flux-redux-style";

    // Get current model's capabilities
    const currentModel = {
        strengthRange: [0, 1] as readonly [number, number],
        supportsNegativePrompt: models.find((m) => m.id === (data.model ?? defaultModel))?.supportsNegativePrompt ?? false,
        supportsWeight: false,
    };

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, { model });
        }
    };

    const handleStrengthChange = (values: number | ReadonlyArray<number>) => {
        const array = Array.isArray(values) ? [...values] : [values];

        updateNode(id, { strength: array[0] });
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    const handleStyleImageChange = (styleImageUrl: string) => {
        updateNode(id, { styleImageUrl });
    };

    const handleContentImageChange = (contentImageUrl: string) => {
        updateNode(id, { contentImageUrl });
    };

    const handlePreserveContentChange = (preserveContent: boolean) => {
        updateNode(id, { preserveContent });
    };

    const [minStrength, maxStrength] = currentModel.strengthRange;

    return (
        <BaseNode {...props} color={config.color} icon={<Palette className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                        <Trans>Style Image URL</Trans>
                    </Label>
                    <Input
                        className="nodrag h-8 text-xs"
                        onChange={(e) => handleStyleImageChange(e.target.value)}
                        placeholder={t`Paste style reference image URL...`}
                        value={data.styleImageUrl ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Image whose artistic style will be applied</Trans>
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Content Image URL (optional)</Trans>
                    </Label>
                    <Input
                        className="nodrag h-8 text-xs"
                        onChange={(e) => handleContentImageChange(e.target.value)}
                        placeholder={t`Paste content image URL to stylize...`}
                        value={data.contentImageUrl ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Image to apply the style to (or use input from previous node)</Trans>
                    </p>
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Style Strength</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{((data.strength ?? 0.8) * 100).toFixed(0)}%</span>
                    </div>
                    <Slider
                        className="nodrag"
                        max={maxStrength}
                        min={minStrength}
                        onValueChange={handleStrengthChange}
                        step={0.05}
                        value={[data.strength ?? 0.8]}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Higher = stronger style influence</Trans>
                    </p>
                </div>

                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Preserve Content</Trans>
                        </Label>
                        <p className="text-muted-foreground text-xs">
                            <Trans>Maintain original structure</Trans>
                        </p>
                    </div>
                    <Switch
                        aria-label={t`Preserve Content`}
                        checked={data.preserveContent ?? true}
                        className="nodrag"
                        onCheckedChange={handlePreserveContentChange}
                    />
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                        <Trans>Generation Prompt (optional)</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`Describe the scene or add style modifiers...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                </div>
            </div>
        </BaseNode>
    );
};

const StyleRefNode = memo(StyleRefNodeComponent);

export default StyleRefNode;
