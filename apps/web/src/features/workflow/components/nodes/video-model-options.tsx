import { Trans } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { FREE_PLAN_MAX_HEIGHT, resolutionWithinFreePlan, videoOptionsOf } from "@neore/ai/models";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import { useId } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { VideoNodeData } from "../../types";
import type { ReferenceModeVariant } from "../../utils/model-options";
import { referenceModeVariants, registryApiIdOf, videoModelPatch } from "../../utils/model-options";
import ProBadge from "./pro-badge";

/** The two fields a video node stores for its endpoint options. */
export type VideoOptionsData = Pick<VideoNodeData, "generateAudio" | "resolution">;

interface VideoModelOptionsProps {
    data: VideoOptionsData;
    id: string;
    /** The registry model id the node calls. */
    modelId: string;
}

/**
 * The audio switch and resolution select for a video node, shown only for the options the selected
 * model takes. Unset values show the endpoint's own default and are not sent.
 */
export const VideoModelOptions = ({ data, id, modelId }: VideoModelOptionsProps) => {
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const modelApiId = registryApiIdOf(modelId);
    const options = videoOptionsOf(modelApiId);

    if (!options || (options.audioDefault === null && !options.resolution)) {
        return null;
    }

    // A value above the free plan's cap is offered, not disabled: plan membership also counts organizations and admins, which the web does not see. The server renders it at the cap otherwise.
    const aboveFreePlan = (value: string): boolean => resolutionWithinFreePlan(modelApiId, value) !== value;
    const resolutionNoteId = `${id}-resolution-note`;
    const hasAboveFreePlan = options.resolution?.values.some((value) => aboveFreePlan(value)) ?? false;

    return (
        <>
            {/* The switch writes the model with the option: the node shows the default model while `model` is unset, but a run reads what is stored. */}
            {options.audioDefault !== null && (
                <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-audio`}>
                        <Trans>Generate audio</Trans>
                    </Label>
                    <Switch
                        checked={data.generateAudio ?? options.audioDefault}
                        className="nodrag"
                        id={`${id}-audio`}
                        onCheckedChange={(checked) => updateNode(id, { generateAudio: checked, model: modelId })}
                    />
                </div>
            )}

            {options.resolution && (
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-resolution`}>
                        <Trans>Resolution</Trans>
                    </Label>
                    <Select
                        onValueChange={(value) => {
                            if (value) {
                                updateNode(id, { model: modelId, resolution: value });
                            }
                        }}
                        value={data.resolution ?? options.resolution.default}
                    >
                        <SelectTrigger
                            aria-describedby={hasAboveFreePlan ? resolutionNoteId : undefined}
                            className="nodrag h-8 text-sm"
                            id={`${id}-resolution`}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {options.resolution.values.map((value) => (
                                <SelectItem key={value} value={value}>
                                    {value}
                                    {aboveFreePlan(value) && <ProBadge />}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {hasAboveFreePlan && (
                        <p className="text-muted-foreground text-xs" id={resolutionNoteId}>
                            <Trans>
                                Above {FREE_PLAN_MAX_HEIGHT}p needs a Pro plan. Otherwise the video renders at {FREE_PLAN_MAX_HEIGHT}p.
                            </Trans>
                        </p>
                    )}
                </div>
            )}
        </>
    );
};

interface ReferenceModeProps {
    data: VideoOptionsData;
    id: string;
    modelId: string;
    /** Every model the picker lists; the family is looked up among the image-to-video ones. */
    models: ReadonlyArray<GatewayModel>;
}

/**
 * The start-frame / references switch for a model family that has both variants (Seedance 2.0 today).
 * Renders nothing for a family with one variant, so a model without a sibling shows no switch.
 */
export const ReferenceMode = ({ data, id, models, modelId }: ReferenceModeProps) => {
    const labelId = useId();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    // A model whose registry row has no FAL endpoint cannot be a variant, so it is skipped rather than matched by its gateway alias.
    const candidates = models.flatMap((model) => {
        const modelApiId = registryApiIdOf(model.id);

        return modelApiId !== undefined && model.enabled && model.supportsImageToVideo
            ? [{ id: model.id, maxReferenceImages: model.maxReferenceImages, modelApiId }]
            : [];
    });
    const current = candidates.find((candidate) => candidate.id === modelId);
    const variants: ReferenceModeVariant[] = referenceModeVariants(current, candidates);

    if (variants.length === 0) {
        return null;
    }

    return (
        <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs" id={labelId}>
                <Trans>Reference mode</Trans>
            </Label>
            <ToggleGroup
                aria-labelledby={labelId}
                className="nodrag w-full"
                onValueChange={(value) => {
                    const next = value?.[0];

                    if (typeof next === "string" && next !== modelId) {
                        updateNode(id, videoModelPatch(next, data));
                    }
                }}
                value={[modelId]}
            >
                {variants.map((variant) => (
                    <ToggleGroupItem className="flex-1 text-xs" key={variant.id} value={variant.id}>
                        {variant.kind === "start-frame" ? <Trans>Start frame</Trans> : <Trans>References</Trans>}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
        </div>
    );
};
