import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import type { SnoozeChoice } from "../lib/thread-state-rules";
import { isSnoozed, snoozeUntil } from "../lib/thread-state-rules";

interface SnoozeMutateVariables {
    chosenAt: number;
    threadId: Id<"threads">;
    until: number;
}

type SnoozeMutate = (variables: SnoozeMutateVariables) => Promise<unknown>;

/**
 * What became of a snooze: `saved`; `refused` (the client refused it before sending, so nothing was saved); or `unconfirmed` (the write
 * was sent and its answer was lost, so the server may have committed it, and the owner should check before saving again).
 */
export type SnoozeOutcome = "saved" | "refused" | "unconfirmed";

interface ThreadStateActions {
    /** Hides the thread until the choice's time; the toast offers an undo that restores the previous snooze, if any. */
    snooze: (threadId: string, choice: SnoozeChoice, previousUntil: number | undefined) => void;

    /**
     * Hides the thread until an exact time (a custom snooze); same toast and undo as `snooze`. Offline, the save is refused at once and
     * never queued for the reconnect.
     */
    snoozeAt: (threadId: string, until: number, previousUntil: number | undefined) => Promise<SnoozeOutcome>;
    /** Brings a snoozed thread back; the toast offers an undo that snoozes it again until the same time. */
    unsnooze: (threadId: string, previousUntil: number | undefined) => void;
}

export const useThreadStateActions = (): ThreadStateActions => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    // Presets and undo keep the client's default: a snooze made offline is queued and sent once the connection returns.
    const { mutateAsync: snoozeMutation } = useMutation(crpc.chat.thread_state.snoozeThread.mutationOptions());
    // A custom time is written straight to the client, online only, and not through the query client. The write's result is then the
    // write's own: a refetch or a cache hook that fails after it cannot read as a failed snooze. `onlineOnly` makes the client refuse
    // it at once when the connection is down, so nothing is queued for the reconnect.
    const writeNow = useCallback(
        async (variables: SnoozeMutateVariables): Promise<unknown> => {
            const { mutationFn } = crpc.chat.thread_state.snoozeThread.mutationOptions(undefined, { onlineOnly: true });

            if (mutationFn === undefined) {
                throw new Error("The snooze write is unavailable.");
            }

            return await mutationFn(variables, { client: queryClient, meta: undefined });
        },
        [crpc, queryClient],
    );
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
    // The result is the write's own outcome. Only the write sits in the try: an error after a successful write (the toast) is not
    // reported as a failed snooze.
    const save = useCallback(
        async (mutate: SnoozeMutate, threadId: string, until: number, previousUntil: number | undefined): Promise<SnoozeOutcome> => {
            try {
                await mutate({ chosenAt: Date.now(), threadId: threadId as Id<"threads">, until });
            } catch (error) {
                console.error("Failed to snooze thread:", error);

                // A refusal before sending is definite: nothing was saved. Any other failure may come after the server committed the
                // write (its answer was lost), so it is not reported as a plain failure that invites an immediate duplicate.
                if ((error as { code?: unknown } | null)?.code === "OFFLINE_NOT_QUEUED") {
                    showError(t`Could not snooze the thread. Please try again.`);

                    return "refused";
                }

                showError(t`Could not confirm the snooze. It may have saved; check the thread before saving again.`);

                return "unconfirmed";
            }

            const when = new Date(until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

            showSuccess(t`Snoozed until ${when}`, { action: { label: t`Undo`, onClick: () => restore(threadId, previousUntil) } });

            return "saved";
        },
        [restore, t],
    );

    const snoozeAt = useCallback(
        (threadId: string, until: number, previousUntil: number | undefined): Promise<SnoozeOutcome> => save(writeNow, threadId, until, previousUntil),
        [save, writeNow],
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
