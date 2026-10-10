import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { PenTool } from "lucide-react";
import { memo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useUpstreamImageUrl } from "../../hooks/use-upstream-image-url";
import { useWorkflowStore } from "../../stores/workflow-store";
import type { ObjectEditorNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";
import MaskSection from "./mask-section";

const EDIT_MODES = [
    { label: msg`Remove Object`, value: "remove" },
    { label: msg`Add/Replace Object`, value: "add" },
] as const satisfies ReadonlyArray<{ label: MessageDescriptor; value: string }>;

const ObjectEditorNodeComponent = (props: NodeProps<Node<ObjectEditorNodeData>>) => {
    const { data, id } = props;
    const { i18n, t } = useLingui();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["object-editor"];

    const inputImageUrl = useUpstreamImageUrl(id);
    const allModels = useFeatureFlaggedModels();

    const isRemoveMode = data.mode === "remove";

    const filteredModels = isRemoveMode
        ? allModels.filter((m) => m.enabled && m.supportsObjectRemoval)
        : allModels.filter((m) => m.enabled && m.supportsInpaint);
    const modelOptions = filteredModels.map((m) => {
        return {
            ...toBaseOption(m),
            supportsNegativePrompt: m.supportsNegativePrompt ?? false,
        };
    });

    const defaultModel = isRemoveMode ? "fal-ai/lama" : (modelOptions[0]?.value ?? "fal-ai/flux-dev-inpaint");

    // Check if current model supports negative prompt
    const currentModelSupportsNegative = allModels.find((m) => m.id === (data.model ?? defaultModel))?.supportsNegativePrompt ?? false;

    const handleModeChange = (mode: string | null) => {
        if (mode === null) {
            return;
        }

        // Reset model when switching modes
        const newDefaultModel = mode === "remove" ? "fal-ai/lama" : "fal-ai/flux-dev-inpaint";

        updateNode(id, { mode: mode as ObjectEditorNodeData["mode"], model: newDefaultModel });
    };

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
        <BaseNode {...props} color={config.color} icon={<PenTool className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Edit Mode</Trans>
                    </Label>
                    <Select onValueChange={handleModeChange} value={data.mode}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {EDIT_MODES.map((mode) => (
                                <SelectItem key={mode.value} value={mode.value}>
                                    {i18n._(mode.label)}
                                </SelectItem>
                            ))}
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
                                    {option.label}
                                    {option.isPremium && <span className="ml-1 text-xs text-amber-500">★</span>}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {!isRemoveMode && (
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                            <Trans>Object Prompt</Trans>
                        </Label>
                        <Textarea
                            className="nodrag min-h-[60px] resize-none text-sm"
                            id={`${id}-prompt`}
                            onChange={(e) => handlePromptChange(e.target.value)}
                            placeholder={t`Describe what to add or replace...`}
                            rows={2}
                            value={data.prompt ?? ""}
                        />
                    </div>
                )}

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-mask`}>
                        <Trans>Mask URL</Trans>
                    </Label>
                    <Input
                        className="nodrag h-8 text-sm"
                        id={`${id}-mask`}
                        onChange={(e) => handleMaskUrlChange(e.target.value)}
                        placeholder={t`https://... (white = edit area)`}
                        value={data.maskUrl ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        {isRemoveMode ? <Trans>Mark the object to remove in white</Trans> : <Trans>Mark the area to edit in white</Trans>}
                    </p>

                    <MaskSection imageUrl={inputImageUrl} maskUrl={data.maskUrl} onMaskChange={(url) => updateNode(id, { maskUrl: url })} />
                </div>

                {!isRemoveMode && currentModelSupportsNegative && (
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
                    {isRemoveMode ? <Trans>LAMA uses AI to seamlessly remove objects</Trans> : <Trans>Connect mask from upstream node or provide URL</Trans>}
                </div>
            </div>
        </BaseNode>
    );
};

const ObjectEditorNode = memo(ObjectEditorNodeComponent);

export default ObjectEditorNode;
