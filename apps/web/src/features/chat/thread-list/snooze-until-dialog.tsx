import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import type { FormEvent } from "react";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useThreadStateActions } from "./hooks/use-thread-state-actions";
import { customSnoozeCheck } from "./lib/thread-state-rules";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Closes the snooze dialog, but only while it is still open for `threadId`. A save that finishes after the owner opened another
 * thread's dialog must not close that one.
 */
export const closeSnoozeDialogFor = (threadId: string): void => {
    const { setSnoozeThreadId, snoozeThreadId } = useThreadListUIStore.getState();

    if (snoozeThreadId === threadId) {
        setSnoozeThreadId(null);
    }
};

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

    /**
     * Where focus goes when the dialog closes. The list, not the control that opened the dialog: that was a menu item, which is
     * gone once the menu closes, and the save may move the row out of the list as well.
     */
    returnFocusTo: () => HTMLElement | null;
    threadId: string;
}

/** Snoozes a thread until a time the owner picks, in their local time. */
const SnoozeUntilDialog = ({ onOpenChange, open, previousUntil, returnFocusTo, threadId }: SnoozeUntilDialogProps) => {
    const { t } = useLingui();
    const { snoozeAt } = useThreadStateActions();
    const inputId = useId();
    const errorId = useId();
    const [value, setValue] = useState(() => toLocalInputValue(Date.now() + HOUR_MS));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const submitReference = useRef<HTMLButtonElement>(null);

    // The dialog closes once the snooze is saved. A failure (offline included) keeps the chosen time here, with the error, and the
    // dialog stays cancellable: Cancel and Escape never wait on the save.
    const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (saving) {
            return;
        }

        const result = customSnoozeCheck(value, new Date());

        if ("problem" in result) {
            setError(
                result.problem === "gap"
                    ? t`That time does not exist on that day, because the clocks skip it. Choose another time.`
                    : t`Choose a time later than now, and within the next year.`,
            );

            return;
        }

        setSaving(true);

        if (await snoozeAt(threadId, result.until, previousUntil)) {
            onOpenChange(false);

            return;
        }

        // The button was disabled while saving, so it lost focus: put focus back on it once it is enabled, so the user is not left on nothing.
        flushSync(() => {
            setSaving(false);
            setError(t`Could not snooze the thread. Please try again.`);
        });
        submitReference.current?.focus();
    };

    // The dialog is mounted only while it is open, so each opening starts from a fresh default time.
    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-sm" finalFocus={returnFocusTo}>
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
                        <Button disabled={saving} ref={submitReference} type="submit">
                            {saving ? t`Saving…` : t`Snooze`}
                        </Button>
                    </DialogFooter>
                    {saving && (
                        <p className="sr-only" role="status">
                            {t`Saving the snooze`}
                        </p>
                    )}
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SnoozeUntilDialog;
