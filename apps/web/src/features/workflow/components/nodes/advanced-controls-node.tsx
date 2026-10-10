import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Switch } from "@ui/components/switch";
import type { Node, NodeProps } from "@xyflow/react";
import { Dice5, SlidersHorizontal } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { AdvancedControlsNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const SAMPLERS = [
    { description: msg`Fast, general purpose`, label: "Euler", value: "euler" },
    { description: msg`More creative variation`, label: "Euler Ancestral", value: "euler_a" },
    { description: msg`High quality, balanced`, label: "DPM++", value: "dpm++" },
    { description: msg`Higher quality, slower`, label: "DPM++ 2M", value: "dpm++_2m" },
    { description: msg`Deterministic, consistent`, label: "DDIM", value: "ddim" },
    { description: msg`Linear multistep`, label: "LMS", value: "lms" },
    { description: msg`Pseudo numerical diffusion`, label: "PNDM", value: "pndm" },
] as const satisfies ReadonlyArray<{ description: MessageDescriptor; label: string; value: string }>;

const SCHEDULERS = [
    { description: msg`Standard noise schedule`, label: "Normal", value: "normal" },
    { description: msg`Better detail preservation`, label: "Karras", value: "karras" },
    { description: msg`Smooth transitions`, label: "Exponential", value: "exponential" },
    { description: msg`Stable Diffusion uniform`, label: "SGM Uniform", value: "sgm_uniform" },
] as const satisfies ReadonlyArray<{ description: MessageDescriptor; label: string; value: string }>;

type SamplerType = AdvancedControlsNodeData["sampler"];
type SchedulerType = AdvancedControlsNodeData["scheduler"];

const AdvancedControlsNodeComponent = (props: NodeProps<Node<AdvancedControlsNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS["advanced-controls"];
    const { i18n, t } = useLingui();

    const handleConfigScaleChange = (value: number | ReadonlyArray<number>) => {
        const values = Array.isArray(value) ? value : [value];

        updateNode(id, { cfgScale: values[0] });
    };

    const handleSamplerChange = (sampler: string | null) => {
        if (sampler) {
            updateNode(id, { sampler: sampler as SamplerType });
        }
    };

    const handleSchedulerChange = (scheduler: string | null) => {
        if (scheduler) {
            updateNode(id, { scheduler: scheduler as SchedulerType });
        }
    };

    const handleStepsChange = (value: number | ReadonlyArray<number>) => {
        const values = Array.isArray(value) ? value : [value];

        updateNode(id, { steps: values[0] });
    };

    const handleSeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { value } = e.target;
        const seed = value === "" ? undefined : Math.trunc(Number(value));

        if (value === "" || !Number.isNaN(seed)) {
            updateNode(id, { seed, useRandomSeed: false });
        }
    };

    const handleRandomSeedToggle = (useRandomSeed: boolean) => {
        updateNode(id, { seed: useRandomSeed ? undefined : data.seed, useRandomSeed });
    };

    const handleClipSkipChange = (value: number | ReadonlyArray<number>) => {
        const values = Array.isArray(value) ? value : [value];

        updateNode(id, { clipSkip: values[0] });
    };

    const generateRandomSeed = () => {
        const [entropy = 0] = crypto.getRandomValues(new Uint32Array(1));
        const randomSeed = entropy % 2_147_483_647;

        updateNode(id, { seed: randomSeed, useRandomSeed: false });
    };

    return (
        <BaseNode
            {...props}
            color={config.color}
            icon={<SlidersHorizontal className="size-4" />}
            inputs={config.handles.inputs}
            outputs={config.handles.outputs}
        >
            <div className="space-y-3">
                {/* CFG Scale */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>CFG Scale</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{data.cfgScale ?? 7}</span>
                    </div>
                    <Slider className="nodrag" max={20} min={1} onValueChange={handleConfigScaleChange} step={0.5} value={[data.cfgScale ?? 7]} />
                    <p className="text-muted-foreground text-[10px]">
                        <Trans>Higher = more prompt adherence, Lower = more creativity</Trans>
                    </p>
                </div>

                {/* Sampler */}
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Sampler</Trans>
                    </Label>
                    <Select onValueChange={handleSamplerChange} value={data.sampler ?? "euler_a"}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SAMPLERS.map((sampler) => (
                                <SelectItem key={sampler.value} value={sampler.value}>
                                    <div className="flex flex-col">
                                        <span>{sampler.label}</span>
                                        <span className="text-muted-foreground text-xs">{i18n._(sampler.description)}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Scheduler */}
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Scheduler</Trans>
                    </Label>
                    <Select onValueChange={handleSchedulerChange} value={data.scheduler ?? "normal"}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SCHEDULERS.map((scheduler) => (
                                <SelectItem key={scheduler.value} value={scheduler.value}>
                                    <div className="flex flex-col">
                                        <span>{scheduler.label}</span>
                                        <span className="text-muted-foreground text-xs">{i18n._(scheduler.description)}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Steps */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Steps</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{data.steps ?? 30}</span>
                    </div>
                    <Slider className="nodrag" max={150} min={10} onValueChange={handleStepsChange} step={5} value={[data.steps ?? 30]} />
                    <p className="text-muted-foreground text-[10px]">
                        <Trans>More steps = higher quality, longer generation</Trans>
                    </p>
                </div>

                {/* Seed */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Seed</Trans>
                        </Label>
                        <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-[10px]">
                                <Trans>Random</Trans>
                            </span>
                            <Switch
                                aria-label={t`Random seed`}
                                checked={data.useRandomSeed ?? true}
                                className="nodrag scale-75"
                                onCheckedChange={handleRandomSeedToggle}
                            />
                        </div>
                    </div>
                    {!data.useRandomSeed && (
                        <div className="flex gap-1.5">
                            <Input
                                className="nodrag h-8 flex-1 text-sm"
                                onChange={handleSeedChange}
                                placeholder={t`Enter seed...`}
                                type="number"
                                value={data.seed ?? ""}
                            />
                            <Button
                                aria-label={t`Generate random seed`}
                                className="nodrag h-8 w-8 shrink-0"
                                onClick={generateRandomSeed}
                                size="icon"
                                title={t`Generate random seed`}
                                variant="outline"
                            >
                                <Dice5 className="size-4" />
                            </Button>
                        </div>
                    )}
                    <p className="text-muted-foreground text-[10px]">
                        <Trans>Same seed = reproducible results</Trans>
                    </p>
                </div>

                {/* CLIP Skip */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>CLIP Skip</Trans>
                        </Label>
                        <span className="text-muted-foreground text-xs">{data.clipSkip ?? 0}</span>
                    </div>
                    <Slider className="nodrag" max={2} min={0} onValueChange={handleClipSkipChange} step={1} value={[data.clipSkip ?? 0]} />
                    <p className="text-muted-foreground text-[10px]">
                        <Trans>Skip CLIP layers (0 = none, 1-2 = more stylized)</Trans>
                    </p>
                </div>
            </div>
        </BaseNode>
    );
};

const AdvancedControlsNode = memo(AdvancedControlsNodeComponent);

export default AdvancedControlsNode;
