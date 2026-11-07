import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import type { SnoozeChoice } from "../lib/thread-state-rules";
import { isSnoozed, snoozeUntil } from "../lib/thread-state-rules";

type SnoozeMutate = (variables: { chosenAt: number; threadId: Id<"threads">; until: number }) => Promise<unknown>;

interface ThreadStateActions {
    /** Hides the thread until the choice's time; the toast offers an undo that restores the previous snooze, if any. */
    snooze: (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => void;

    /**
     * Hides the thread until an exact time (a custom snooze); same toast and undo as `snooze`. Resolves true once saved,
     * false (after the error toast) when not. Offline, the save is refused at once and never queued for the reconnect.
     */
    snoozeAt: (threadId: string, until: number, previousUntil: number | undefined) => Promise<boolean>;
    /** Brings a snoozed thread back; the toast offers an undo that snoozes it again until the same time. */
    unsnooze: (threadId: string, previousUntil: number | undefined) => void;
}

export const useThreadStateActions = (): ThreadStateActions => {
    const { t } = useLingui();
    const crpc = useCRPC();
    // Presets and undo keep the client's default: a snooze made offline is queued and sent once the connection returns.
    const { mutateAsync: snoozeMutation } = useMutation(crpc.chat.thread_state.snoozeThread.mutationOptions());
    // A custom time is saved only while online. The client refuses an `onlineOnly` write at once when the connection is down (the
    // default queues it for the reconnect), so no write is left to land later. `networkMode: "always"` stops the query client from
    // pausing it first, and `retry: 0` stops a second attempt.
    const { mutateAsync: snoozeNowMutation } = useMutation({
        ...crpc.chat.thread_state.snoozeThread.mutationOptions(undefined, { onlineOnly: true }),
        networkMode: "always",
        retry: 0,
    });
    const { mutateAsync: unsnoozeMutation } = useMutation(crpc.chat.thread_state.unsnoozeThread.mutationOptions());

    const restore = useCallback(
        (threadId: string, previousUntil: number | undefined) => {
            // Undo is a choice made now: it is stamped now, so a snooze queued before it cannot bring back a newer one.
            const chosenAt = Date.now();
            const request =
                previousUntil !== undefined && isSnoozed(previousUntil, chosenAt)
                    ? snoozeMutation({ chosenAt, threadId: threadId as Id<"threads">, until: previousUntil })
                    : unsnoozeMutation({ chosenAt, threadId: threadId as Id<"threads"> });

            request.catch((error) => {
                console.error("Failed to restore the snooze:", error);
                showError(t`Could not undo. Please try again.`);
            });
        },
        [snoozeMutation, unsnoozeMutation, t],
    );

    // The choice is stamped when the user makes it, not when the write is sent: a write queued offline keeps that time, so a choice
    // made later on the thread wins when the queue drains.
    const save = useCallback(
        (mutate: SnoozeMutate, threadId: string, until: number, previousUntil: number | undefined): Promise<boolean> =>
            mutate({ chosenAt: Date.now(), threadId: threadId as Id<"threads">, until })
                .then(() => {
                    const when = new Date(until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

                    showSuccess(t`Snoozed until ${when}`, { action: { label: t`Undo`, onClick: () => restore(threadId, previousUntil) } });

                    return true;
                })
                .catch((error) => {
                    console.error("Failed to snooze thread:", error);
                    showError(t`Could not snooze the thread. Please try again.`);

                    return false;
                }),
        [restore, t],
    );

    const snoozeAt = useCallback(
        (threadId: string, until: number, previousUntil: number | undefined): Promise<boolean> => save(snoozeNowMutation, threadId, until, previousUntil),
        [save, snoozeNowMutation],
    );

    const snooze = useCallback(
        (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => {
            void save(snoozeMutation, threadId, snoozeUntil(choice, new Date()), previousUntil);
        },
        [save, snoozeMutation],
    );

    const unsnooze = useCallback(
        (threadId: string, previousUntil: number | undefined) => {
            unsnoozeMutation({ chosenAt: Date.now(), threadId: threadId as Id<"threads"> })
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

    return { snooze, snoozeAt, unsnooze };
};
