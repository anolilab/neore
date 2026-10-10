"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { Loader2, Sparkles } from "lucide-react";
import { useId, useState } from "react";

import { useAction } from "@/lib/lunora/crpc";

import type { SkillVariable } from "../lib/skill-form";

export interface SkillDraft {
    additionalTools: string[];
    category?: string;
    description: string;
    instructions: string;
    name: string;
    slug: string;
    tags: string[];
    variables: SkillVariable[];
}

const MIN_GOAL_LENGTH = 10;
const MAX_GOAL_LENGTH = 2000;

interface SkillGeneratePanelProps {
    onDraft: (draft: SkillDraft) => void;
}

/**
 * Asks the backend to draft a skill from a described goal. The draft only
 * pre-fills the form; nothing is saved until the user submits it.
 */
const SkillGeneratePanel = ({ onDraft }: SkillGeneratePanelProps) => {
    const { t } = useLingui();
    const id = useId();
    const generate = useAction(api.skills.generate.generateSkillDraft);
    const [goal, setGoal] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [status, setStatus] = useState<{ kind: "error" | "success"; message: string } | null>(null);

    const trimmed = goal.trim();
    const isTooShort = trimmed.length < MIN_GOAL_LENGTH;

    const handleGenerate = async () => {
        if (isTooShort || isGenerating) {
            return;
        }

        setIsGenerating(true);
        setStatus(null);

        try {
            const draft = await generate({ goal: trimmed });

            onDraft(draft);
            setStatus({ kind: "success", message: t`Draft ready — review the fields below before saving.` });
        } catch (error) {
            setStatus({ kind: "error", message: error instanceof Error && error.message ? error.message : t`Could not generate a draft. Try again.` });
        } finally {
            setIsGenerating(false);
        }
    };

    return (
        <section aria-labelledby={`${id}-heading`} className="bg-muted/40 space-y-3 rounded-lg border p-4">
            <div className="space-y-1">
                <h3 className="flex items-center gap-2 text-sm font-medium" id={`${id}-heading`}>
                    <Sparkles aria-hidden="true" className="size-4" />
                    {t`Generate from a description`}
                </h3>
                <p className="text-muted-foreground text-xs" id={`${id}-hint`}>
                    {t`Describe what the skill should do. The fields below are filled in for you to review.`}
                </p>
            </div>
            <Label className="sr-only" htmlFor={`${id}-goal`}>
                {t`Skill goal`}
            </Label>
            <Textarea
                aria-describedby={`${id}-hint`}
                id={`${id}-goal`}
                maxLength={MAX_GOAL_LENGTH}
                onChange={(event) => setGoal(event.target.value)}
                onKeyDown={(event) => {
                    // The panel lives inside the skill <form>; Ctrl/Cmd+Enter generates
                    // rather than submitting the half-filled skill.
                    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
                        return;
                    }

                    event.preventDefault();
                    void handleGenerate();
                }}
                placeholder={t`e.g. Review pull requests for security issues and summarise the risks in a table`}
                rows={3}
                value={goal}
            />
            <div className="flex items-center justify-between gap-2">
                <p aria-live="polite" className={status?.kind === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"} role="status">
                    {isGenerating ? t`Generating draft…` : status?.message}
                </p>
                <Button aria-busy={isGenerating} disabled={isTooShort || isGenerating} onClick={handleGenerate} size="sm" type="button" variant="secondary">
                    {isGenerating ? (
                        <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                    ) : (
                        <Sparkles aria-hidden="true" className="mr-2 size-4" />
                    )}
                    {t`Generate`}
                </Button>
            </div>
        </section>
    );
};

export default SkillGeneratePanel;
