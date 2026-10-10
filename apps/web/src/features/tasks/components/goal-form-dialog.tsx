"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useId, useState } from "react";
import { toast } from "sonner";

import type { BoardGoal } from "../lib/task-board";
import { CRITERIA_MAX, TITLE_MAX } from "../lib/task-board";

type GoalStatus = BoardGoal["status"];

export interface GoalFormValues {
    description: string;
    status: GoalStatus;
    successCriteria: string;
    title: string;
}

interface GoalFormDialogProps {
    editingGoal?: BoardGoal | null;
    onClose: () => void;
    onSubmit: (values: GoalFormValues) => Promise<void>;
    open: boolean;
}

const GoalFormDialogBody = ({ editingGoal, onClose, onSubmit }: Omit<GoalFormDialogProps, "open">) => {
    const { t } = useLingui();
    const baseId = useId();
    const [values, setValues] = useState<GoalFormValues>({
        description: editingGoal?.description ?? "",
        status: editingGoal?.status ?? "active",
        successCriteria: editingGoal?.successCriteria ?? "",
        title: editingGoal?.title ?? "",
    });
    const [submitted, setSubmitted] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const titleError = submitted && !values.title.trim() ? t`Title is required` : undefined;

    const statusLabels: Record<GoalStatus, string> = {
        active: t`Active`,
        archived: t`Archived`,
        completed: t`Completed`,
    };

    const handleSubmit = async () => {
        setSubmitted(true);

        if (!values.title.trim()) {
            return;
        }

        setIsSubmitting(true);

        try {
            await onSubmit(values);
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to save goal`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <DialogContent className="max-w-lg">
            <DialogHeader>
                <DialogTitle>{editingGoal ? t`Edit goal` : t`New goal`}</DialogTitle>
                <DialogDescription>{t`A goal groups tasks. Its progress follows from how many of them are done.`}</DialogDescription>
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
                            <Label htmlFor={`${baseId}-title`}>{t`Title`}</Label>
                            <Input
                                aria-describedby={titleError ? `${baseId}-title-error` : undefined}
                                aria-invalid={!!titleError}
                                id={`${baseId}-title`}
                                maxLength={TITLE_MAX}
                                onChange={(event) =>
                                    setValues((previous) => {
                                        return { ...previous, title: event.target.value };
                                    })
                                }
                                required
                                value={values.title}
                            />
                            {titleError && (
                                <p className="text-destructive text-xs" id={`${baseId}-title-error`}>
                                    {titleError}
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
                        <div className="space-y-2">
                            <Label htmlFor={`${baseId}-criteria`}>{t`Success criteria`}</Label>
                            <Textarea
                                id={`${baseId}-criteria`}
                                maxLength={CRITERIA_MAX}
                                onChange={(event) =>
                                    setValues((previous) => {
                                        return { ...previous, successCriteria: event.target.value };
                                    })
                                }
                                value={values.successCriteria}
                            />
                        </div>
                        {editingGoal && (
                            <div className="space-y-2">
                                <Label id={`${baseId}-status`}>{t`Status`}</Label>
                                <Select
                                    items={(Object.keys(statusLabels) as GoalStatus[]).map((status) => {
                                        return { label: statusLabels[status], value: status };
                                    })}
                                    onValueChange={(value) =>
                                        setValues((previous) => {
                                            return { ...previous, status: (value ?? "active") as GoalStatus };
                                        })
                                    }
                                    value={values.status}
                                >
                                    <SelectTrigger aria-labelledby={`${baseId}-status`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(Object.keys(statusLabels) as GoalStatus[]).map((status) => (
                                            <SelectItem key={status} value={status}>
                                                {statusLabels[status]}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button aria-busy={isSubmitting} disabled={isSubmitting} type="submit">
                        {editingGoal ? t`Save changes` : t`Create goal`}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const GoalFormDialog = ({ open, ...props }: GoalFormDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <GoalFormDialogBody key={props.editingGoal?._id ?? "new"} {...props} />}
    </Dialog>
);

export default GoalFormDialog;
