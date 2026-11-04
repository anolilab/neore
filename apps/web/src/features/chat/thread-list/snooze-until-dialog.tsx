import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import type { FormEvent } from "react";
import { useId, useState } from "react";

import { useThreadStateActions } from "./hooks/use-thread-state-actions";
import { customSnoozeUntil } from "./lib/thread-state-rules";

const HOUR_MS = 60 * 60 * 1000;

/** The local `YYYY-MM-DDTHH:mm` a `datetime-local` input takes, for a time. */
const toLocalInputValue = (time: number): string => {
    const date = new Date(time);
    const pad = (value: number): string => String(value).padStart(2, "0");

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

interface SnoozeUntilDialogProps {
    onOpenChange: (open: boolean) => void;
    open: boolean;
    /** The snooze the thread had before, which the undo toast restores. */
    previousUntil: number | undefined;
    threadId: string;
}

/** Snoozes a thread until a time the owner picks, in their local time. */
const SnoozeUntilDialog = ({ onOpenChange, open, previousUntil, threadId }: SnoozeUntilDialogProps) => {
    const { t } = useLingui();
    const { snoozeAt } = useThreadStateActions();
    const inputId = useId();
    const errorId = useId();
    const [value, setValue] = useState(() => toLocalInputValue(Date.now() + HOUR_MS));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // The dialog closes only once the snooze is saved. A failure keeps the chosen time here, with the error, so it can be retried.
    const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (saving) {
            return;
        }

        const until = customSnoozeUntil(value, new Date());

        if (until === undefined) {
            setError(t`Choose a time later than now, and within the next year.`);

            return;
        }

        setSaving(true);

        if (await snoozeAt(threadId, until, previousUntil)) {
            onOpenChange(false);

            return;
        }

        setSaving(false);
        setError(t`Could not snooze the thread. Please try again.`);
    };

    // The dialog is mounted only while it is open, so each opening starts from a fresh default time.
    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t`Snooze until`}</DialogTitle>
                    <DialogDescription>{t`The thread leaves your active list until then. An approval, a question or a failed run brings it back sooner.`}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" noValidate onSubmit={onSubmit}>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={inputId}>{t`Wake up at`}</Label>
                        <Input
                            aria-describedby={error ? errorId : undefined}
                            aria-invalid={error ? true : undefined}
                            id={inputId}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setError(null);
                            }}
                            type="datetime-local"
                            value={value}
                        />
                        {error && (
                            <p className="text-destructive text-sm" id={errorId} role="alert">
                                {error}
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={saving} type="submit">
                            {t`Snooze`}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SnoozeUntilDialog;
