"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";

import PromptModelSelector from "@/features/prompts/components/prompt-model-selector";
import { useCRPC } from "@/lib/lunora/crpc";

import type { EvalDataset } from "../lib/evals-format";

interface RunDialogProps {
    dataset: EvalDataset;
    onClose: () => void;
    onStarted: (runId: Id<"evalRuns">) => void;
    open: boolean;
}

const DEFAULT_COST_CAP_USD = "1";

const DEFAULT_TOKEN_BUDGET = "200000";

const RunDialogBody = ({ dataset, onClose, onStarted }: Omit<RunDialogProps, "open">) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const baseId = useId();
    const rag = dataset.kind === "rag";
    const { data: skills = [] } = useQuery(crpc.tasks.functions.listTaskSkillOptions.queryOptions({}));
    const { data: files = [] } = useQuery({ ...crpc.knowledge.functions.listFiles.queryOptions({}), enabled: rag });
    const startRun = useMutation(crpc.evals.functions.startRun.mutationOptions());

    const [targetKind, setTargetKind] = useState<"model" | "skill">("skill");
    const [skillId, setSkillId] = useState<Id<"skills"> | undefined>(undefined);
    const [model, setModel] = useState<string | undefined>(undefined);
    const [systemPrompt, setSystemPrompt] = useState("");
    const [fileIds, setFileIds] = useState<Id<"knowledgeFiles">[]>([]);
    const [costCap, setCostCap] = useState(DEFAULT_COST_CAP_USD);
    const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);
    const [label, setLabel] = useState("");
    const [problem, setProblem] = useState<string | undefined>(undefined);

    const indexedFiles = files.filter((file) => file.status === "indexed");

    const toggleFile = (fileId: Id<"knowledgeFiles">, checked: boolean) =>
        setFileIds((previous) => (checked ? [...previous, fileId] : previous.filter((existing) => existing !== fileId)));

    const buildTarget = () => {
        if (rag) {
            return { fileIds, kind: "knowledge" as const, ...(model && { model }) };
        }

        if (targetKind === "skill") {
            return skillId ? { kind: "skill" as const, skillId, ...(model && { model }) } : undefined;
        }

        return model ? { kind: "model" as const, model, ...(systemPrompt.trim() && { systemPrompt: systemPrompt.trim() }) } : undefined;
    };

    const handleSubmit = async () => {
        const target = buildTarget();

        if (!target) {
            setProblem(targetKind === "skill" ? t`Pick a skill to evaluate.` : t`Pick a model to evaluate.`);

            return;
        }

        const cap = Number(costCap);

        if (!Number.isFinite(cap) || cap <= 0) {
            setProblem(t`The cost cap must be a positive number of dollars.`);

            return;
        }

        const tokens = Number(tokenBudget);

        if (!Number.isSafeInteger(tokens) || tokens <= 0) {
            setProblem(t`The token budget must be a whole number of tokens.`);

            return;
        }

        setProblem(undefined);

        try {
            const { runId } = await startRun.mutateAsync({
                costCapUsd: cap,
                datasetId: dataset._id,
                label: label.trim() || undefined,
                target,
                tokenBudget: tokens,
            });

            onStarted(runId);
            onClose();
        } catch (error) {
            setProblem(error instanceof Error && error.message ? error.message : t`Failed to start the run`);
            toast.error(t`Failed to start the run`);
        }
    };

    return (
        <DialogContent className="max-w-lg">
            <DialogHeader>
                <DialogTitle>{t`Run "${dataset.name}"`}</DialogTitle>
                <DialogDescription>
                    {t`Each case runs once, one after another. Every case counts toward your daily message and task limits, and the run stops when it reaches its cost cap.`}
                </DialogDescription>
            </DialogHeader>
            <form
                autoComplete="off"
                className="contents"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSubmit();
                }}
            >
                <DialogPanel>
                    <div className="space-y-4">
                        {rag ? (
                            <fieldset className="space-y-2">
                                <legend className="text-sm font-medium">{t`Knowledge files to search`}</legend>
                                <p className="text-muted-foreground text-xs">{t`Leave all unchecked to search every indexed file.`}</p>
                                {indexedFiles.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">{t`You have no indexed knowledge files yet.`}</p>
                                ) : (
                                    <ul className="max-h-48 space-y-2 overflow-y-auto">
                                        {indexedFiles.map((file) => {
                                            const id = `${baseId}-file-${file._id}`;

                                            return (
                                                <li className="flex items-center gap-2" key={file._id}>
                                                    <Checkbox
                                                        checked={fileIds.includes(file._id)}
                                                        id={id}
                                                        onCheckedChange={(checked) => toggleFile(file._id, checked)}
                                                    />
                                                    <Label className="font-normal" htmlFor={id}>
                                                        {file.name}
                                                    </Label>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </fieldset>
                        ) : (
                            <div aria-labelledby={`${baseId}-target`} className="space-y-2" role="group">
                                <Label id={`${baseId}-target`}>{t`Evaluate`}</Label>
                                <RadioGroup
                                    aria-labelledby={`${baseId}-target`}
                                    onValueChange={(value) => setTargetKind(value === "model" ? "model" : "skill")}
                                    value={targetKind}
                                >
                                    <div className="flex items-center gap-2">
                                        <RadioGroupItem id={`${baseId}-target-skill`} value="skill" />
                                        <Label className="font-normal" htmlFor={`${baseId}-target-skill`}>
                                            {t`An agent (skill)`}
                                        </Label>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <RadioGroupItem id={`${baseId}-target-model`} value="model" />
                                        <Label className="font-normal" htmlFor={`${baseId}-target-model`}>
                                            {t`A model with a system prompt`}
                                        </Label>
                                    </div>
                                </RadioGroup>
                            </div>
                        )}

                        {!rag && targetKind === "skill" && (
                            <div className="space-y-2">
                                <Label id={`${baseId}-skill`}>{t`Skill`}</Label>
                                {skills.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">{t`Enable a skill first — only enabled skills can be evaluated.`}</p>
                                ) : (
                                    <Select
                                        items={skills.map((skill) => {
                                            return { label: `/${skill.slug} — ${skill.name}`, value: skill._id };
                                        })}
                                        onValueChange={(value) => setSkillId((value ?? undefined) as Id<"skills"> | undefined)}
                                        value={skillId ?? null}
                                    >
                                        <SelectTrigger aria-labelledby={`${baseId}-skill`}>
                                            <SelectValue placeholder={t`Pick a skill`} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {skills.map((skill) => (
                                                <SelectItem key={skill._id} value={skill._id}>
                                                    /{skill.slug} — {skill.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                        )}

                        <div aria-labelledby={`${baseId}-model`} className="space-y-2" role="group">
                            <Label id={`${baseId}-model`}>{t`Model`}</Label>
                            <PromptModelSelector onChange={setModel} value={model} />
                            <p className="text-muted-foreground text-xs">
                                {!rag && targetKind === "model" ? t`Required.` : t`Optional. Defaults to the skill's preferred model, then the default model.`}
                            </p>
                        </div>

                        {!rag && targetKind === "model" && (
                            <div className="space-y-2">
                                <Label htmlFor={`${baseId}-system`}>{t`System prompt`}</Label>
                                <Textarea id={`${baseId}-system`} onChange={(event) => setSystemPrompt(event.target.value)} value={systemPrompt} />
                            </div>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor={`${baseId}-cap`}>{t`Cost cap (USD)`}</Label>
                                <Input
                                    aria-describedby={`${baseId}-cap-hint`}
                                    id={`${baseId}-cap`}
                                    inputMode="decimal"
                                    max={25}
                                    min={0.01}
                                    onChange={(event) => setCostCap(event.target.value)}
                                    step={0.01}
                                    type="number"
                                    value={costCap}
                                />
                                <p className="text-muted-foreground text-xs" id={`${baseId}-cap-hint`}>
                                    {t`$0.01 to $25.`}
                                </p>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor={`${baseId}-tokens`}>{t`Token budget`}</Label>
                                <Input
                                    aria-describedby={`${baseId}-tokens-hint`}
                                    id={`${baseId}-tokens`}
                                    inputMode="numeric"
                                    max={5_000_000}
                                    min={10_000}
                                    onChange={(event) => setTokenBudget(event.target.value)}
                                    step={1000}
                                    type="number"
                                    value={tokenBudget}
                                />
                                <p className="text-muted-foreground text-xs" id={`${baseId}-tokens-hint`}>
                                    {t`10,000 to 5,000,000. Applies to cases that report no cost — your own API keys or custom endpoints without pricing.`}
                                </p>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor={`${baseId}-label`}>{t`Label`}</Label>
                                <Input
                                    id={`${baseId}-label`}
                                    maxLength={120}
                                    onChange={(event) => setLabel(event.target.value)}
                                    placeholder={t`e.g. new prompt v2`}
                                    value={label}
                                />
                            </div>
                        </div>

                        {problem && (
                            <p className="text-destructive text-sm" role="alert">
                                {problem}
                            </p>
                        )}
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button aria-busy={startRun.isPending} disabled={startRun.isPending || dataset.caseCount === 0} type="submit">
                        {t`Start run`}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const RunDialog = ({ open, ...props }: RunDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <RunDialogBody {...props} />}
    </Dialog>
);

export default RunDialog;
