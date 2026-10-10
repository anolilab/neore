"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { useId, useState } from "react";

import { useAction, useCRPCClient } from "@/lib/lunora/crpc";

import type { BuilderAcceptance, BuilderDraft, BuilderQuestion, BuilderRecommendations, FieldDiff } from "../lib/skill-builder";
import { acceptedConnectors, acceptedMcpServers, buildDraftDiff, carryAcceptance, defaultAcceptance, toCreateSkillArgs } from "../lib/skill-builder";
import { validateSkillForm } from "../lib/skill-form";
import SkillBuilderDiff from "./skill-builder-diff";
import SkillBuilderReview from "./skill-builder-review";
import SkillBuilderTestDrive from "./skill-builder-test-drive";

const MIN_GOAL_LENGTH = 10;
const MAX_GOAL_LENGTH = 2000;
const MAX_REFINE_LENGTH = 1000;

/** Product names — not translated. */
export const CONNECTOR_LABELS: Record<string, string> = {
    github: "GitHub",
    gmail: "Gmail",
    "google-drive": "Google Drive",
    notion: "Notion",
    slack: "Slack",
};

export interface SkillBuilderSaved {
    connectors: BuilderRecommendations["connectors"];
    mcpServers: BuilderRecommendations["mcpServers"];
    name: string;
}

interface SkillBuilderDialogProps {
    onClose: () => void;
    onSaved: (saved: SkillBuilderSaved) => void;
    onUseMarketplaceSkill: (skillId: Id<"skills">) => void;
    open: boolean;
}

type Step = { kind: "goal" } | { kind: "questions"; questions: BuilderQuestion[] } | { kind: "review" };

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

const SkillBuilderBody = ({ onClose, onSaved, onUseMarketplaceSkill }: Omit<SkillBuilderDialogProps, "open">) => {
    const { t } = useLingui();
    const id = useId();
    const crpcClient = useCRPCClient();
    const runTurn = useAction(api.skills.builder.runBuilderTurn);
    const refine = useAction(api.skills.builder.refineBuilderDraft);

    const [step, setStep] = useState<Step>({ kind: "goal" });
    const [goal, setGoal] = useState("");
    const [answers, setAnswers] = useState<string[]>([]);
    const [draft, setDraft] = useState<BuilderDraft | null>(null);
    const [recommendations, setRecommendations] = useState<BuilderRecommendations | null>(null);
    const [acceptance, setAcceptance] = useState<BuilderAcceptance | null>(null);
    const [refineText, setRefineText] = useState("");
    const [diff, setDiff] = useState<FieldDiff[] | null>(null);
    const [busy, setBusy] = useState<"refining" | "saving" | "thinking" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const trimmedGoal = goal.trim();

    const submitTurn = async (options: { skipQuestions?: boolean; withAnswers?: boolean }) => {
        if (busy || trimmedGoal.length < MIN_GOAL_LENGTH) {
            return;
        }

        setBusy("thinking");
        setError(null);

        try {
            const questions = step.kind === "questions" ? step.questions : [];
            const result = await runTurn({
                answers: options.withAnswers
                    ? questions
                          .map((question, index) => {
                              return { answer: answers[index]?.trim() ?? "", question: question.question };
                          })
                          .filter((item) => item.answer)
                    : undefined,
                goal: trimmedGoal,
                skipQuestions: options.skipQuestions,
            });

            if (result.kind === "questions") {
                setAnswers(result.questions.map(() => ""));
                setStep({ kind: "questions", questions: result.questions });

                return;
            }

            setDraft(result.draft);
            setRecommendations(result.recommendations);
            setAcceptance(defaultAcceptance(result.draft, result.recommendations));
            setDiff(null);
            setStep({ kind: "review" });
        } catch (turnError) {
            setError(errorText(turnError, t`The builder could not answer. Try again.`));
        } finally {
            setBusy(null);
        }
    };

    const submitRefine = async () => {
        const instruction = refineText.trim();

        if (!draft || !acceptance || busy || instruction.length < 3) {
            return;
        }

        setBusy("refining");
        setError(null);

        try {
            const result = await refine({ draft, instruction });

            setDiff(buildDraftDiff(draft, result.draft, result.changedFields));
            setDraft(result.draft);
            setAcceptance(carryAcceptance(acceptance, result.draft));
            setRefineText("");
        } catch (refineError) {
            setError(errorText(refineError, t`Could not refine the draft. Try again.`));
        } finally {
            setBusy(null);
        }
    };

    const save = async () => {
        if (!draft || !acceptance || !recommendations || busy) {
            return;
        }

        const args = toCreateSkillArgs(draft, acceptance);
        const invalid = validateSkillForm({
            additionalTools: args.config.additionalTools ?? [],
            category: args.category ?? "",
            description: args.description,
            disabledTools: args.config.disabledTools ?? [],
            instructions: args.instructions,
            name: args.name,
            slug: args.slug,
            tags: "",
            variables: args.variables,
            visibility: "private",
            voice: "",
        });

        if (Object.keys(invalid).length > 0) {
            setError(t`Fill in a name, a valid command, a description and instructions before saving.`);

            return;
        }

        setBusy("saving");
        setError(null);

        try {
            await crpcClient.mutation(api.skills.functions.createSkill, args);
            onSaved({
                connectors: acceptedConnectors(recommendations, acceptance),
                mcpServers: acceptedMcpServers(recommendations, acceptance),
                name: args.name,
            });
            onClose();
        } catch (saveError) {
            setError(errorText(saveError, t`Failed to save skill`));
        } finally {
            setBusy(null);
        }
    };

    const busyLabels = { refining: t`Refining the draft…`, saving: t`Saving…`, thinking: t`Thinking…` };
    const statusText = busy ? busyLabels[busy] : null;

    const setAnswerAt = (index: number, value: string) => {
        setAnswers((previous) => previous.map((answer, i) => (i === index ? value : answer)));
    };

    const handleContinue = () => submitTurn({});
    const handleSkipQuestions = () => submitTurn({ skipQuestions: true });
    const handleBuildDraft = () => submitTurn({ withAnswers: true });

    return (
        <DialogContent className="max-w-3xl">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                    <Wand2 aria-hidden="true" className="size-5" />
                    {t`Agent builder`}
                </DialogTitle>
                <DialogDescription>
                    {t`Describe what you want. The builder asks if something is unclear, then proposes a skill you can review, try and save.`}
                </DialogDescription>
            </DialogHeader>
            <DialogPanel className="max-h-[65vh] min-h-0 flex-1 overflow-y-auto">
                <div className="space-y-6">
                    {step.kind !== "review" && (
                        <div className="space-y-2">
                            <Label htmlFor={`${id}-goal`}>{t`What should the agent do?`}</Label>
                            <Textarea
                                aria-describedby={`${id}-goal-hint`}
                                disabled={step.kind === "questions"}
                                id={`${id}-goal`}
                                maxLength={MAX_GOAL_LENGTH}
                                onChange={(event) => setGoal(event.target.value)}
                                placeholder={t`e.g. Every Monday, summarise new GitHub issues in my repo and draft replies for the urgent ones`}
                                rows={4}
                                value={goal}
                            />
                            <p className="text-muted-foreground text-xs" id={`${id}-goal-hint`}>
                                {t`Nothing is saved, installed or enabled until you choose to save.`}
                            </p>
                        </div>
                    )}

                    {step.kind === "questions" && (
                        <section aria-labelledby={`${id}-questions`} className="space-y-4">
                            <h3 className="text-sm font-medium" id={`${id}-questions`}>
                                {t`A few questions first`}
                            </h3>
                            {step.questions.map((question, index) => (
                                <div className="space-y-2" key={question.question}>
                                    <Label htmlFor={`${id}-answer-${index}`}>{question.question}</Label>
                                    {question.why && <p className="text-muted-foreground text-xs">{question.why}</p>}
                                    {question.options.length > 0 && (
                                        <div aria-label={t`Suggested answers`} className="flex flex-wrap gap-2" role="group">
                                            {question.options.map((option) => (
                                                <Button
                                                    aria-pressed={answers[index] === option}
                                                    key={option}
                                                    onClick={() => setAnswerAt(index, option)}
                                                    size="sm"
                                                    type="button"
                                                    variant={answers[index] === option ? "secondary" : "outline"}
                                                >
                                                    {option}
                                                </Button>
                                            ))}
                                        </div>
                                    )}
                                    <Input
                                        id={`${id}-answer-${index}`}
                                        maxLength={1000}
                                        onChange={(event) => setAnswerAt(index, event.target.value)}
                                        value={answers[index] ?? ""}
                                    />
                                </div>
                            ))}
                        </section>
                    )}

                    {step.kind === "review" && draft && recommendations && acceptance && (
                        <>
                            <SkillBuilderReview
                                acceptance={acceptance}
                                connectorLabels={CONNECTOR_LABELS}
                                draft={draft}
                                onAcceptanceChange={setAcceptance}
                                onDraftChange={setDraft}
                                onUseMarketplaceSkill={(skillId) => {
                                    onUseMarketplaceSkill(skillId);
                                    onClose();
                                }}
                                recommendations={recommendations}
                            />

                            <section aria-labelledby={`${id}-refine`} className="space-y-3">
                                <h3 className="flex items-center gap-2 text-sm font-medium" id={`${id}-refine`}>
                                    <Sparkles aria-hidden="true" className="size-4" />
                                    {t`Refine`}
                                </h3>
                                <div className="flex gap-2">
                                    <Label className="sr-only" htmlFor={`${id}-refine-input`}>
                                        {t`What should change?`}
                                    </Label>
                                    <Input
                                        id={`${id}-refine-input`}
                                        maxLength={MAX_REFINE_LENGTH}
                                        onChange={(event) => setRefineText(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key !== "Enter") {
                                                return;
                                            }

                                            event.preventDefault();
                                            submitRefine().catch(() => undefined);
                                        }}
                                        placeholder={t`e.g. Make the output a table and drop web search`}
                                        value={refineText}
                                    />
                                    <Button
                                        aria-busy={busy === "refining"}
                                        disabled={!!busy || refineText.trim().length < 3}
                                        onClick={submitRefine}
                                        type="button"
                                        variant="secondary"
                                    >
                                        {t`Refine`}
                                    </Button>
                                </div>
                                {diff && <SkillBuilderDiff diff={diff} />}
                            </section>

                            <SkillBuilderTestDrive acceptance={acceptance} draft={draft} />
                        </>
                    )}
                </div>
            </DialogPanel>
            <DialogFooter className="flex-wrap items-center gap-2">
                <p aria-live="polite" className={error ? "text-destructive mr-auto text-xs" : "text-muted-foreground mr-auto text-xs"} role="status">
                    {statusText ?? error}
                </p>
                <Button onClick={onClose} type="button" variant="outline">
                    {t`Cancel`}
                </Button>
                {step.kind === "goal" && (
                    <Button aria-busy={busy === "thinking"} disabled={!!busy || trimmedGoal.length < MIN_GOAL_LENGTH} onClick={handleContinue} type="button">
                        {busy === "thinking" && <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />}
                        {t`Continue`}
                    </Button>
                )}
                {step.kind === "questions" && (
                    <>
                        <Button disabled={!!busy} onClick={handleSkipQuestions} type="button" variant="ghost">
                            {t`Skip questions`}
                        </Button>
                        <Button
                            aria-busy={busy === "thinking"}
                            disabled={!!busy || answers.every((answer) => !answer.trim())}
                            onClick={handleBuildDraft}
                            type="button"
                        >
                            {busy === "thinking" && <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />}
                            {t`Build draft`}
                        </Button>
                    </>
                )}
                {step.kind === "review" && (
                    <Button aria-busy={busy === "saving"} disabled={!!busy} onClick={save} type="button">
                        {busy === "saving" && <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />}
                        {t`Save skill`}
                    </Button>
                )}
            </DialogFooter>
        </DialogContent>
    );
};

/**
 * The guided Agent Builder. State lives in the body, which only mounts while
 * open, so closing discards an unsaved draft.
 */
const SkillBuilderDialog = ({ open, ...props }: SkillBuilderDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <SkillBuilderBody {...props} />}
    </Dialog>
);

export default SkillBuilderDialog;
