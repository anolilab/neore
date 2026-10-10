import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Plus, User, X } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { CharacterRefNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { toBaseOption } from "../../utils/model-options";
import BaseNode from "./base-node";

const MODE_OPTIONS = [
    { description: msg`Preserve facial features`, label: msg`Face`, value: "face" },
    { description: msg`Apply artistic style`, label: msg`Style`, value: "style" },
    { description: msg`Match layout and structure`, label: msg`Composition`, value: "composition" },
] as const satisfies ReadonlyArray<{ description: MessageDescriptor; label: MessageDescriptor; value: string }>;

const CharacterRefNodeComponent = (props: NodeProps<Node<CharacterRefNodeData>>) => {
    const { data, id } = props;
    const { i18n, t } = useLingui();
    const referenceCount = data.referenceImages?.length ?? 0;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["character-ref"];
    const models = useFeatureFlaggedModels();

    const modelOptions = useMemo(() => {
        const options = [];

        for (const m of models) {
            if (m.enabled && m.supportsCharacterRef) {
                options.push({
                    ...toBaseOption(m),
                    maxImages: m.maxReferenceImages ?? 4,
                    modes: m.characterRefModes ?? ["face", "style", "composition"],
                });
            }
        }

        return options;
    }, [models]);

    const defaultModel = modelOptions[0]?.value ?? "fal-ai/flux-pro-redux";

    // Get current model's capabilities
    const currentModel = useMemo(() => {
        const modelId = data.model ?? defaultModel;
        const modelDefinition = models.find((m) => m.id === modelId);

        return {
            maxImages: modelDefinition?.maxReferenceImages ?? 4,
            modes: modelDefinition?.characterRefModes ?? ["face", "style", "composition"],
            supportsNegativePrompt: modelDefinition?.supportsNegativePrompt ?? false,
        };
    }, [data.model, defaultModel, models]);

    const { maxImages } = currentModel;

    // Filter mode options based on model support
    const availableModes = useMemo(() => MODE_OPTIONS.filter((mode) => currentModel.modes.includes(mode.value)), [currentModel.modes]);

    const handleModelChange = useCallback(
        (model: string | null) => {
            if (!model) {
                return;
            }

            // Reset mode if new model doesn't support current mode
            const newModelDef = models.find((m) => m.id === model);
            const newModes = newModelDef?.characterRefModes ?? ["face", "style", "composition"];
            const currentMode = data.mode ?? "face";

            if (newModes.includes(currentMode)) {
                updateNode(id, { model });
            } else {
                updateNode(id, { mode: newModes[0] as "face" | "style" | "composition", model });
            }
        },
        [data.mode, id, models, updateNode],
    );

    const handleModeChange = useCallback(
        (mode: string | null) => {
            if (mode) {
                updateNode(id, { mode: mode as "face" | "style" | "composition" });
            }
        },
        [id, updateNode],
    );

    const handleStrengthChange = useCallback(
        (values: number | ReadonlyArray<number>) => {
            const array = Array.isArray(values) ? [...values] : [values];

            updateNode(id, { strength: array[0] });
        },
        [id, updateNode],
    );

    const handlePromptChange = useCallback(
        (prompt: string) => {
            updateNode(id, { prompt });
        },
        [id, updateNode],
    );

    const handleAddReferenceImage = useCallback(
        (url: string) => {
            if (!(url && (data.referenceImages?.length ?? 0) < currentModel.maxImages)) {
                return;
            }

            const newImages = [...(data.referenceImages ?? []), url];

            updateNode(id, { referenceImages: newImages });
        },
        [currentModel.maxImages, data.referenceImages, id, updateNode],
    );

    const handleRemoveReferenceImage = useCallback(
        (index: number) => {
            const newImages = [...(data.referenceImages ?? [])];

            newImages.splice(index, 1);
            updateNode(id, { referenceImages: newImages });
        },
        [data.referenceImages, id, updateNode],
    );

    return (
        <BaseNode {...props} color={config.color} icon={<User className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                        <Trans>
                            Reference Images ({referenceCount}/{maxImages})
                        </Trans>
                    </Label>
                    <div className="space-y-2">
                        {data.referenceImages?.map((url, index) => (
                            <div className="flex items-center gap-2" key={url}>
                                <div className="bg-muted flex-1 truncate rounded px-2 py-1 text-xs">
                                    {url.slice(0, 30)}
                                    ...
                                </div>
                                <Button
                                    aria-label={t`Remove reference image`}
                                    className="nodrag h-6 w-6"
                                    onClick={() => handleRemoveReferenceImage(index)}
                                    size="icon"
                                    variant="ghost"
                                >
                                    <X className="size-3" />
                                </Button>
                            </div>
                        ))}
                        {(data.referenceImages?.length ?? 0) < currentModel.maxImages && (
                            <div className="flex gap-2">
                                <Input
                                    className="nodrag h-8 text-xs"
                                    onKeyDown={(e) => {
                                        if (e.key !== "Enter" || e.nativeEvent.isComposing) {
                                            return;
                                        }

                                        handleAddReferenceImage((e.target as HTMLInputElement).value);
                                        (e.target as HTMLInputElement).value = "";
                                    }}
                                    placeholder={t`Paste image URL...`}
                                />
                                <Button
                                    aria-label={t`Add reference image`}
                                    className="nodrag h-8 w-8 shrink-0"
                                    onClick={() => {
                                        const input = document.querySelector(`#ref-input-${id}`) as HTMLInputElement;

                                        if (input?.value) {
                                            handleAddReferenceImage(input.value);
                                            input.value = "";
                                        }
                                    }}
                                    size="icon"
                                    variant="outline"
                                >
                                    <Plus className="size-4" />
                                </Button>
                            </div>
                        )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                        <Trans>Add reference images to maintain consistency</Trans>
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Reference Mode</Trans>
                    </Label>
                    <Select onValueChange={handleModeChange} value={data.mode ?? "face"}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {availableModes.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    <div className="flex flex-col">
                                        <span>{i18n._(option.label)}</span>
                                        <span className="text-muted-foreground text-xs">{i18n._(option.description)}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Reference Strength</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{((data.strength ?? 0.8) * 100).toFixed(0)}%</span>
                    </div>
                    <Slider className="nodrag" max={1} min={0} onValueChange={handleStrengthChange} step={0.05} value={[data.strength ?? 0.8]} />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Higher = closer match to reference</Trans>
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                        <Trans>Generation Prompt (optional)</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-prompt`}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        placeholder={t`Describe the scene or context...`}
                        rows={2}
                        value={data.prompt ?? ""}
                    />
                </div>
            </div>
        </BaseNode>
    );
};

const CharacterRefNode = memo(CharacterRefNodeComponent);

export default CharacterRefNode;
