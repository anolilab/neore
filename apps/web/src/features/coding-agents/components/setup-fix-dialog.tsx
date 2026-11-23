"use client";

/**
 * "Fix setup" on a run that failed at a setup step the repository can break. The
 * prepared task (built by the backend: the step, the end of its log, the ask) is
 * shown for reading and editing; nothing starts until the person clicks Start.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Wrench } from "lucide-react";
import type { FC, RefObject } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

/** The backend's task limit (`PROMPT_MAX` in `coding-agents/commands.ts`). */
const PROMPT_MAX = 20_000;

interface SetupFixButtonProps {
    /** Where focus goes when the dialog closes. The button itself leaves the page once the fix starts. */
    finalFocusRef: RefObject<HTMLElement | null>;
    prompt: string;
    runId: Id<"codingAgentRuns">;
    step: string;
}

const SetupFixButton: FC<SetupFixButtonProps> = ({ finalFocusRef, prompt: preparedPrompt, runId, step }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const fieldId = useId();
    const helpId = useId();
    const [open, setOpen] = useState(false);
    // Set once a fix has started: then the button is gone, so focus goes to the run. Otherwise focus returns to the button.
    const [started, setStarted] = useState(false);
    const [prompt, setPrompt] = useState(preparedPrompt);
    const start = useMutation(crpc.coding_agents.functions.startSetupFix.mutationOptions());
    const trimmed = prompt.trim();

    const openDialog = () => {
        setPrompt(preparedPrompt);
        setStarted(false);
        setOpen(true);
    };

    const submit = () => {
        start.mutate(
            { prompt: trimmed, runId },
            {
                onError: (error: unknown) => showError(error instanceof Error ? error : t`Could not start the fix.`),
                onSuccess: (result) => {
                    if ("error" in result) {
                        showError(result.error);

                        return;
                    }

                    setStarted(true);
                    setOpen(false);
                    showSuccess(t`Fix started — follow it below`);
                },
            },
        );
    };

    return (
        <>
            <Button onClick={openDialog} size="sm" variant="outline">
                <Wrench aria-hidden="true" />
                {t`Fix setup`}
            </Button>
            <Dialog onOpenChange={setOpen} open={open}>
                <DialogContent className="sm:max-w-2xl" finalFocus={started ? finalFocusRef : undefined}>
                    <DialogHeader>
                        <DialogTitle>{t`Fix the "${step}" step`}</DialogTitle>
                        <DialogDescription>
                            {t`A new run on the same repository and branch will fix the cause in the repository and run the step again. Read and edit its task before you start it.`}
                        </DialogDescription>
                    </DialogHeader>
                    {/* The panel scrolls on a short screen, so the footer's buttons stay reachable under a tall task. */}
                    <DialogPanel>
                        <div className="grid gap-2">
                            <Label htmlFor={fieldId}>{t`Task for the coding agent`}</Label>
                            <Textarea
                                aria-describedby={trimmed.length === 0 ? helpId : undefined}
                                className="max-h-[50vh] min-h-48 font-mono text-xs"
                                id={fieldId}
                                maxLength={PROMPT_MAX}
                                onChange={(event) => setPrompt(event.target.value)}
                                required
                                spellCheck
                                value={prompt}
                            />
                            {trimmed.length === 0 && (
                                <p className="text-muted-foreground text-xs" id={helpId}>
                                    {t`Write the task for the agent before you start the fix.`}
                                </p>
                            )}
                        </div>
                    </DialogPanel>
                    <DialogFooter>
                        <Button disabled={start.isPending} onClick={() => setOpen(false)} variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={start.isPending || trimmed.length === 0} onClick={submit}>
                            {start.isPending && <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
                            {t`Start fix`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};

export default SetupFixButton;
