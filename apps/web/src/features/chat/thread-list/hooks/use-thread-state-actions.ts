import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import type { SnoozeChoice } from "../lib/thread-state-rules";
import { isSnoozed, nextSnoozeChoiceAt, snoozeUntil } from "../lib/thread-state-rules";

interface ThreadStateActions {
    /** Hides the thread until the choice's time; the toast offers an undo that restores the previous snooze, if any. */
    snooze: (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => void;
    /** Hides the thread until an exact time (the "Snooze until…" dialog); same toast and undo as `snooze`. */
    snoozeAt: (threadId: string, until: number, previousUntil: number | undefined) => void;
    /** Brings a snoozed thread back; the toast offers an undo that snoozes it again until the same time. */
    unsnooze: (threadId: string, previousUntil: number | undefined) => void;
}

/** The server answers `applied: false` when the thread already has a newer choice, or woke after this one was made. */
const wasSuperseded = (result: { applied: boolean } | null | undefined): boolean => result?.applied === false;

export const useThreadStateActions = (): ThreadStateActions => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { mutateAsync: snoozeMutation } = useMutation(crpc.chat.thread_state.snoozeThread.mutationOptions());
    const { mutateAsync: unsnoozeMutation } = useMutation(crpc.chat.thread_state.unsnoozeThread.mutationOptions());
    const superseded = useCallback(() => showError(t`A newer change to this thread is already in place, so this did not apply.`), [t]);

    // Every write is stamped when the owner makes the choice, not when it is sent: a write queued offline keeps that stamp.
    const restore = useCallback(
        (threadId: string, previousUntil: number | undefined) => {
            const chosenAt = nextSnoozeChoiceAt(Date.now());
            const request =
                previousUntil !== undefined && isSnoozed(previousUntil, chosenAt)
                    ? snoozeMutation({ chosenAt, threadId: threadId as Id<"threads">, until: previousUntil })
                    : unsnoozeMutation({ chosenAt, threadId: threadId as Id<"threads"> });

            request
                .then((result) => {
                    if (wasSuperseded(result)) {
                        superseded();
                    }

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to restore the snooze:", error);
                    showError(t`Could not undo. Please try again.`);
                });
        },
        [snoozeMutation, unsnoozeMutation, superseded, t],
    );

    const snoozeAt = useCallback(
        (threadId: string, until: number, previousUntil: number | undefined) => {
            snoozeMutation({ chosenAt: nextSnoozeChoiceAt(Date.now()), threadId: threadId as Id<"threads">, until })
                .then((result) => {
                    if (wasSuperseded(result)) {
                        superseded();

                        return undefined;
                    }

                    const when = new Date(until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

                    showSuccess(t`Snoozed until ${when}`, { action: { label: t`Undo`, onClick: () => restore(threadId, previousUntil) } });

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to snooze thread:", error);
                    showError(t`Could not snooze the thread. Please try again.`);
                });
        },
        [snoozeMutation, restore, superseded, t],
    );

    const snooze = useCallback(
        (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => snoozeAt(threadId, snoozeUntil(choice, new Date()), previousUntil),
        [snoozeAt],
    );

    const unsnooze = useCallback(
        (threadId: string, previousUntil: number | undefined) => {
            unsnoozeMutation({ chosenAt: nextSnoozeChoiceAt(Date.now()), threadId: threadId as Id<"threads"> })
                .then((result) => {
                    if (wasSuperseded(result)) {
                        superseded();

                        return undefined;
                    }

                    showSuccess(t`Thread unsnoozed`, { action: { label: t`Undo`, onClick: () => restore(threadId, previousUntil) } });

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to unsnooze thread:", error);
                    showError(t`Could not unsnooze the thread. Please try again.`);
                });
        },
        [unsnoozeMutation, restore, superseded, t],
    );

    return { snooze, snoozeAt, unsnooze };
};
