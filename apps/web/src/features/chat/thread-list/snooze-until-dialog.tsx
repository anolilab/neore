import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

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
    /** The snooze the thread had when the dialog opened, which the undo toast restores. */
    previousUntil: number | undefined;
    /** Where focus goes when the dialog closes. The parent unmounts the dialog on close, so this runs from the unmount. */
    restoreFocus?: () => HTMLElement | null;
    threadId: string;
}

/**
 * Snoozes a thread until a local date and time the owner picks. A time that is not in the future, or more than a year away, is
 * refused here; a valid one closes the dialog and is saved like a preset, with the same toast and undo.
 */
const SnoozeUntilDialog = ({ onOpenChange, open, previousUntil, restoreFocus, threadId }: SnoozeUntilDialogProps) => {
    const { t } = useLingui();
    const { snoozeAt } = useThreadStateActions();
    const inputId = useId();
    const errorId = useId();
    const [value, setValue] = useState(() => toLocalInputValue(Date.now() + HOUR_MS));
    const [error, setError] = useState<string | null>(null);
    const timeInput = useRef<HTMLInputElement>(null);
    // Fixed for the dialog's lifetime: the parent mounts it for one thread and unmounts it on close.
    const [returnFocusTo] = useState(() => restoreFocus);
    const pendingRestore = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Focus returns from the unmount, as in the rename dialog: the menu item that opened this one is gone. StrictMode replays the
    // mount, so the replayed cleanup's restore is cancelled.
    useEffect(() => {
        if (pendingRestore.current !== null) {
            clearTimeout(pendingRestore.current);
            pendingRestore.current = null;
        }

        return () => {
            pendingRestore.current = setTimeout(() => {
                pendingRestore.current = null;
                returnFocusTo?.()?.focus();
            }, 0);
        };
    }, [returnFocusTo]);

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const until = customSnoozeUntil(value, Date.now());

        if (until === undefined) {
            setError(t`Choose a time later than now, and within the next year.`);
            timeInput.current?.focus();

            return;
        }

        snoozeAt(threadId, until, previousUntil);
        onOpenChange(false);
    };

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-sm" finalFocus={returnFocusTo} initialFocus={timeInput}>
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
                            aria-required="true"
                            id={inputId}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setError(null);
                            }}
                            ref={timeInput}
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
                        <Button type="submit">{t`Snooze`}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SnoozeUntilDialog;
