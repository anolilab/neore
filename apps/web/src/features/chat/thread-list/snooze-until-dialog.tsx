import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { showError } from "@/lib/toast";

import type { SnoozeOutcome } from "./hooks/use-thread-state-actions";
import { useThreadStateActions } from "./hooks/use-thread-state-actions";
import { customSnoozeCheck } from "./lib/thread-state-rules";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";

const HOUR_MS = 60 * 60 * 1000;

/** The focus return a closed dialog scheduled, if it has not run yet (see `SnoozeUntilDialog`). */
const pendingFocusReturn: { timer?: ReturnType<typeof globalThis.setTimeout> } = {};

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

/**
 * The thread's row inside the list, the focus target once its snooze dialog closes. A snoozed row can have moved out of the
 * active groups, so the list itself is the fallback.
 */
export const threadRowFocusTarget = (list: HTMLElement | null, threadId: string): HTMLElement | null => {
    const rows = [...(list?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? [])];
    const row = rows.find((element) => element.dataset.threadId === threadId && element.getAttribute("role") === "button");

    return row ?? list;
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
     * Where focus goes when the dialog closes: the thread's row (`threadRowFocusTarget`). Not the control that opened the dialog,
     * which was a menu item and is gone once the menu closes.
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
    const timeReference = useRef<HTMLInputElement>(null);
    // Whether this opening of the dialog is still open. It is set false when the dialog unmounts, so a save it started cannot act on a later opening.
    const opened = useRef(true);

    useEffect(() => {
        opened.current = true;

        return () => {
            opened.current = false;
        };
    }, []);
    const [returnFocus] = useState(() => returnFocusTo);

    // A focus return still pending from a dialog that just closed must not take focus from this one.
    useEffect(() => {
        globalThis.clearTimeout(pendingFocusReturn.timer);
    }, []);

    // Focus goes back to the thread once the dialog is gone, on desktop and on mobile alike. This is not `finalFocus`: the mobile drawer
    // drops that prop, which is why focus was lost there. The check is made when the return runs, not when the dialog unmounts: a thread
    // that left the list still has its id in the store until the list clears it, and that must not cancel the return. Only another
    // thread's open dialog suppresses it, since its focus is its own.
    useEffect(
        () => () => {
            pendingFocusReturn.timer = globalThis.setTimeout(() => {
                const openThreadId = useThreadListUIStore.getState().snoozeThreadId;

                if (openThreadId !== null && openThreadId !== threadId) {
                    return;
                }

                returnFocus()?.focus();
            }, 0);
        },
        [returnFocus, threadId],
    );

    // What the dialog says when a save did not go through. Each outcome has its own message, and the dialog stays open for all of them.
    const failureMessage = (outcome: Exclude<SnoozeOutcome, "saved">): string => {
        if (outcome === "unconfirmed") {
            return t`Could not confirm the snooze. It may have saved; check the thread before saving again.`;
        }

        if (outcome === "superseded") {
            return t`A newer change to this thread is already in place, so this did not apply.`;
        }

        return t`Could not snooze the thread. Please try again.`;
    };

    // The dialog closes once the snooze is saved. A failure (offline included) keeps the chosen time here, with the error, and the
    // dialog stays cancellable: Cancel and Escape never wait on the save.
    const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (saving) {
            return;
        }

        // A submit with no time is refused with its own message, and the field takes focus: nothing is saved and the dialog stays open.
        if (value.trim() === "") {
            setError(t`Choose a wake-up time.`);
            timeReference.current?.focus();

            return;
        }

        const result = customSnoozeCheck(value, new Date());

        if ("problem" in result) {
            setError(
                result.problem === "gap"
                    ? t`That time does not exist on that day, because the clocks skip it. Choose another time.`
                    : t`Choose a time later than now, and within the next year.`,
            );
            timeReference.current?.focus();

            return;
        }

        setSaving(true);

        const outcome = await snoozeAt(threadId, result.until, previousUntil);

        if (outcome === "saved") {
            // A save that finishes after this dialog closed (cancelled, or taken over) closes nothing: a new opening may be open now.
            if (opened.current) {
                onOpenChange(false);
            }

            return;
        }

        // The owner cancelled or escaped while the save was in flight, so the dialog is gone. The outcome is said on a toast instead:
        // a save that may have landed must not vanish with the dialog.
        if (!opened.current) {
            showError(failureMessage(outcome));

            return;
        }

        // The button was disabled while saving, so it lost focus: put focus back on it once it is enabled, so the user is not left on nothing.
        flushSync(() => {
            setSaving(false);
            setError(failureMessage(outcome));
        });
        submitReference.current?.focus();
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
                            aria-required="true"
                            disabled={saving}
                            id={inputId}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setError(null);
                            }}
                            ref={timeReference}
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
