import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import type { Node, NodeProps } from "@xyflow/react";
import { Scissors } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { BackgroundRemovalNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const OUTPUT_FORMATS = [
    { label: msg`PNG (Transparent)`, value: "png" },
    { label: msg`WebP (Smaller)`, value: "webp" },
] as const satisfies ReadonlyArray<{ label: MessageDescriptor; value: string }>;

const BackgroundRemovalNodeComponent = (props: NodeProps<Node<BackgroundRemovalNodeData>>) => {
    const { data, id } = props;
    const { i18n, t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["background-removal"];
    const models = useFeatureFlaggedModels();

    const modelOptions = models.flatMap((m) => (m.enabled && m.supportsBackgroundRemoval ? [toBaseOption(m)] : []));

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/birefnet";

    const handleModelChange = (model: string | null) => {
        if (model) {
            updateNode(id, { model });
        }
    };

    const handleFormatChange = (outputFormat: string | null) => {
        if (outputFormat === null) {
            return;
        }

        updateNode(id, { outputFormat: outputFormat as BackgroundRemovalNodeData["outputFormat"] });
    };

    const handleRefineMaskChange = (refineMask: boolean) => {
        updateNode(id, { refineMask });
    };

    const handleBackgroundColorChange = (backgroundColor: string) => {
        updateNode(id, { backgroundColor: backgroundColor || undefined });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Scissors className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                        <Trans>Output Format</Trans>
                    </Label>
                    <Select onValueChange={handleFormatChange} value={data.outputFormat ?? "png"}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {OUTPUT_FORMATS.map((format) => (
                                <SelectItem key={format.value} value={format.value}>
                                    {i18n._(format.label)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-refine`}>
                        <Trans>Refine Edge Detection</Trans>
                    </Label>
                    <Switch checked={data.refineMask ?? true} className="nodrag" id={`${id}-refine`} onCheckedChange={handleRefineMaskChange} />
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-bgcolor`}>
                        <Trans>Background Color (optional)</Trans>
                    </Label>
                    <div className="flex gap-2">
                        <Input
                            className="nodrag h-8 w-12 p-1"
                            disabled={!data.backgroundColor}
                            id={`${id}-bgcolor`}
                            onChange={(e) => handleBackgroundColorChange(e.target.value)}
                            type="color"
                            value={data.backgroundColor ?? "#ffffff"}
                        />
                        <Input
                            className="nodrag h-8 flex-1 text-sm"
                            onChange={(e) => handleBackgroundColorChange(e.target.value)}
                            placeholder={t`Transparent`}
                            value={data.backgroundColor ?? ""}
                        />
                    </div>
                    <p className="text-muted-foreground text-xs">
                        <Trans>Leave empty for transparent background</Trans>
                    </p>
                </div>

                <div className="text-muted-foreground bg-muted/50 rounded p-2 text-xs">
                    <Trans>Connect an image node as input</Trans>
                </div>
            </div>
        </BaseNode>
    );
};

const BackgroundRemovalNode = memo(BackgroundRemovalNodeComponent);

export default BackgroundRemovalNode;
