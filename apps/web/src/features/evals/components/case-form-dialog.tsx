"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useState } from "react";
import { toast } from "sonner";

import type { CaseFormValues, EvalCase } from "../lib/evals-format";
import { caseToForm, EMPTY_CASE } from "../lib/evals-format";
import CaseFields from "./case-fields";

interface CaseFormDialogProps {
    editing?: EvalCase | null;
    /** Knowledge file ids, so a stored source that is one shows as a picked file rather than as text. */
    knownFileIds?: ReadonlySet<string>;
    onClose: () => void;
    onSubmit: (values: CaseFormValues) => Promise<void>;
    open: boolean;
    rag: boolean;
}

const CaseFormBody = ({ editing, knownFileIds, onClose, onSubmit, rag }: Omit<CaseFormDialogProps, "open">) => {
    const { t } = useLingui();
    const [values, setValues] = useState<CaseFormValues>(editing ? caseToForm(editing, knownFileIds) : EMPTY_CASE);
    const [submitted, setSubmitted] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async () => {
        setSubmitted(true);

        if (!values.input.trim()) {
            return;
        }

        setIsSubmitting(true);

        try {
            await onSubmit(values);
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to save the case`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <DialogContent className="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{editing ? t`Edit case` : t`New case`}</DialogTitle>
                <DialogDescription>{t`What to send, and how to tell a good answer from a bad one.`}</DialogDescription>
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
                    <CaseFields rag={rag} setValues={setValues} showErrors={submitted} values={values} />
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button aria-busy={isSubmitting} disabled={isSubmitting} type="submit">
                        {editing ? t`Save changes` : t`Add case`}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const CaseFormDialog = ({ open, ...props }: CaseFormDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <CaseFormBody key={props.editing?._id ?? "new"} {...props} />}
    </Dialog>
);

export default CaseFormDialog;
