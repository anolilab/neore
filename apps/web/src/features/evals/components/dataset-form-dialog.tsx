"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useId, useState } from "react";
import { toast } from "sonner";

import type { EvalDataset } from "../lib/evals-format";
import { NAME_MAX } from "../lib/evals-format";

export interface DatasetFormValues {
    description: string;
    judgeEnabled: boolean;
    kind: EvalDataset["kind"];
    name: string;
}

interface DatasetFormDialogProps {
    editing?: EvalDataset | null;
    onClose: () => void;
    onSubmit: (values: DatasetFormValues) => Promise<void>;
    open: boolean;
}

const DatasetFormBody = ({ editing, onClose, onSubmit }: Omit<DatasetFormDialogProps, "open">) => {
    const { t } = useLingui();
    const baseId = useId();
    const [values, setValues] = useState<DatasetFormValues>({
        description: editing?.description ?? "",
        judgeEnabled: editing?.judgeEnabled ?? true,
        kind: editing?.kind ?? "agent",
        name: editing?.name ?? "",
    });
    const [submitted, setSubmitted] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const nameError = submitted && !values.name.trim() ? t`Name is required` : undefined;

    const handleSubmit = async () => {
        setSubmitted(true);

        if (!values.name.trim()) {
            return;
        }

        setIsSubmitting(true);

        try {
            await onSubmit(values);
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to save the dataset`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <DialogContent className="max-w-lg">
            <DialogHeader>
                <DialogTitle>{editing ? t`Edit dataset` : t`New dataset`}</DialogTitle>
                <DialogDescription>{t`A dataset is a set of test cases you run against an agent, a model or your knowledge base.`}</DialogDescription>
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
                        <div className="space-y-2">
                            <Label htmlFor={`${baseId}-name`}>{t`Name`}</Label>
                            <Input
                                aria-describedby={nameError ? `${baseId}-name-error` : undefined}
                                aria-invalid={!!nameError}
                                id={`${baseId}-name`}
                                maxLength={NAME_MAX}
                                onChange={(event) =>
                                    setValues((previous) => {
                                        return { ...previous, name: event.target.value };
                                    })
                                }
                                required
                                value={values.name}
                            />
                            {nameError && (
                                <p className="text-destructive text-xs" id={`${baseId}-name-error`}>
                                    {nameError}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor={`${baseId}-description`}>{t`Description`}</Label>
                            <Textarea
                                id={`${baseId}-description`}
                                onChange={(event) =>
                                    setValues((previous) => {
                                        return { ...previous, description: event.target.value };
                                    })
                                }
                                value={values.description}
                            />
                        </div>
                        {!editing && (
                            <div aria-labelledby={`${baseId}-kind`} className="space-y-2" role="group">
                                <Label id={`${baseId}-kind`}>{t`What it evaluates`}</Label>
                                <RadioGroup
                                    aria-labelledby={`${baseId}-kind`}
                                    onValueChange={(value) =>
                                        setValues((previous) => {
                                            return { ...previous, kind: value === "rag" ? "rag" : "agent" };
                                        })
                                    }
                                    value={values.kind}
                                >
                                    <div className="flex items-start gap-2">
                                        <RadioGroupItem aria-describedby={`${baseId}-kind-agent-hint`} id={`${baseId}-kind-agent`} value="agent" />
                                        <div>
                                            <Label htmlFor={`${baseId}-kind-agent`}>{t`Agent answers`}</Label>
                                            <p className="text-muted-foreground text-xs" id={`${baseId}-kind-agent-hint`}>
                                                {t`Run a skill, or a model with a system prompt, on each case.`}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-start gap-2">
                                        <RadioGroupItem aria-describedby={`${baseId}-kind-rag-hint`} id={`${baseId}-kind-rag`} value="rag" />
                                        <div>
                                            <Label htmlFor={`${baseId}-kind-rag`}>{t`Knowledge retrieval`}</Label>
                                            <p className="text-muted-foreground text-xs" id={`${baseId}-kind-rag-hint`}>
                                                {t`Search your knowledge files and score retrieval (hit rate, MRR, precision, recall) and faithfulness.`}
                                            </p>
                                        </div>
                                    </div>
                                </RadioGroup>
                            </div>
                        )}
                        <div className="flex items-start gap-2">
                            <Checkbox
                                aria-describedby={`${baseId}-judge-hint`}
                                checked={values.judgeEnabled}
                                id={`${baseId}-judge`}
                                onCheckedChange={(checked) =>
                                    setValues((previous) => {
                                        return { ...previous, judgeEnabled: checked === true };
                                    })
                                }
                            />
                            <div>
                                <Label htmlFor={`${baseId}-judge`}>{t`Grade answers with an AI judge`}</Label>
                                <p className="text-muted-foreground text-xs" id={`${baseId}-judge-hint`}>
                                    {t`Scores each answer 0–100% against the expected answer or rubric. Adds a small model call per case.`}
                                </p>
                            </div>
                        </div>
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button aria-busy={isSubmitting} disabled={isSubmitting} type="submit">
                        {editing ? t`Save changes` : t`Create dataset`}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const DatasetFormDialog = ({ open, ...props }: DatasetFormDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <DatasetFormBody key={props.editing?._id ?? "new"} {...props} />}
    </Dialog>
);

export default DatasetFormDialog;
