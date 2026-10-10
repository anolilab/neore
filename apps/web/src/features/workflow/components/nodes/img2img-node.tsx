import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Wand2 } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { Img2ImgNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const Img2ImgNodeComponent = (props: NodeProps<Node<Img2ImgNodeData>>) => {
    const { data, id } = props;
    const { t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.img2img;
    const models = useFeatureFlaggedModels();

    const modelOptions = [];

    for (const m of models) {
        if (m.enabled && m.supportsImg2Img) {
            modelOptions.push(toBaseOption(m));
        }
    }

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/flux-dev-img2img";

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, { model });
        }
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    const handleStrengthChange = (values: number | ReadonlyArray<number>) => {
        const array = Array.isArray(values) ? [...values] : [values];

        updateNode(id, { strength: array[0] });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Wand2 className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                        <Trans>Transformation Prompt</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`Describe how to transform the image...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Strength</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{((data.strength ?? 0.75) * 100).toFixed(0)}%</span>
                    </div>
                    <Slider className="nodrag" max={1} min={0} onValueChange={handleStrengthChange} step={0.05} value={[data.strength ?? 0.75]} />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Lower = subtle changes, Higher = major transformation</Trans>
                    </p>
                </div>
            </div>
        </BaseNode>
    );
};

const Img2ImgNode = memo(Img2ImgNodeComponent);

export default Img2ImgNode;
