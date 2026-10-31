import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import type { SnoozeChoice } from "../lib/thread-state-rules";
import { isSnoozed, snoozeUntil } from "../lib/thread-state-rules";

interface ThreadStateActions {
    /** Hides the thread until the choice's time; the toast offers an undo that restores the previous snooze, if any. */
    snooze: (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => void;
    /** Brings a snoozed thread back; the toast offers an undo that snoozes it again until the same time. */
    unsnooze: (threadId: string, previousUntil: number | undefined) => void;
}

export const useThreadStateActions = (): ThreadStateActions => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { mutateAsync: snoozeMutation } = useMutation(crpc.chat.thread_state.snoozeThread.mutationOptions());
    const { mutateAsync: unsnoozeMutation } = useMutation(crpc.chat.thread_state.unsnoozeThread.mutationOptions());

    const restore = useCallback(
        (threadId: string, previousUntil: number | undefined) => {
            const request =
                previousUntil !== undefined && isSnoozed(previousUntil, Date.now())
                    ? snoozeMutation({ threadId: threadId as Id<"threads">, until: previousUntil })
                    : unsnoozeMutation({ threadId: threadId as Id<"threads"> });

            request.catch((error) => {
                console.error("Failed to restore the snooze:", error);
                showError(t`Could not undo. Please try again.`);
            });
        },
        [snoozeMutation, unsnoozeMutation, t],
    );

    const snooze = useCallback(
        (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => {
            const until = snoozeUntil(choice, new Date());

            snoozeMutation({ threadId: threadId as Id<"threads">, until })
                .then(() => {
                    const when = new Date(until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

                    showSuccess(t`Snoozed until ${when}`, { action: { label: t`Undo`, onClick: () => restore(threadId, previousUntil) } });

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to snooze thread:", error);
                    showError(t`Could not snooze the thread. Please try again.`);
                });
        },
        [snoozeMutation, restore, t],
    );

    const unsnooze = useCallback(
        (threadId: string, previousUntil: number | undefined) => {
            unsnoozeMutation({ threadId: threadId as Id<"threads"> })
                .then(() => {
                    showSuccess(t`Thread unsnoozed`, { action: { label: t`Undo`, onClick: () => restore(threadId, previousUntil) } });

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to unsnooze thread:", error);
                    showError(t`Could not unsnooze the thread. Please try again.`);
                });
        },
        [unsnoozeMutation, restore, t],
    );

    return { snooze, unsnooze };
};
