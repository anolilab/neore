import { useCallback, useEffect, useRef, useState } from "react";

import { isThreadRefusal } from "@/offline/message-read";

import type { Confirmation, ConfirmPageFetch } from "./reply-confirmation";
import { CONFIRM_READ_INTERVAL_MS, readReplyState, tallyChecks } from "./reply-confirmation";
import type { ReplyState } from "./reply-state";

interface ReplyConfirmationOptions {
    fetchPage: ConfirmPageFetch;
    /** A reply's checks ended, whether it settled or was given up: the screen can clear what it was waiting on. */
    onEnded: () => void;
    /** The chat can no longer be read: the screen clears it and forgets its saved copy. */
    onRefused: (threadId: string) => void;
    threadId: string | undefined;
}

/**
 * The checks after each send. Each send's reply is checked on a timer until its server copy is final. A later send does
 * not end an earlier one's checks. The history is re-read while a reply's checks wait, and again when they settle.
 */
export const useReplyConfirmation = ({ fetchPage, onEnded, onRefused, threadId }: ReplyConfirmationOptions) => {
    const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
    const [confirmTick, setConfirmTick] = useState(0);
    // Checks made so far for each reply, by message id: kept here so a new send does not restart an earlier reply's count.
    const confirmReads = useRef(new Map<string, number>());
    const isAwaitingReply = confirmations.some((confirmation) => confirmation.threadId === threadId && confirmation.holdsSend);

    useEffect(() => {
        if (threadId === undefined) {
            return undefined;
        }

        const own = confirmations.filter((confirmation) => confirmation.threadId === threadId);

        if (own.length === 0) {
            return undefined;
        }

        let isActive = true;
        let isChecking = false;

        const check = async () => {
            if (isChecking) {
                return;
            }

            isChecking = true;
            const outcomes = await Promise.all(
                own.map(async (confirmation) => {
                    try {
                        return { confirmation, isChatRefused: false, state: await readReplyState(fetchPage, threadId, confirmation.messageId, confirmation.steers) };
                    } catch (error_) {
                        // A chat the reader can no longer open ends the checks; any other failure is tried again on the next tick.
                        return { confirmation, isChatRefused: isThreadRefusal(error_), state: "unknown" as ReplyState };
                    }
                }),
            );

            isChecking = false;

            if (!isActive) {
                return;
            }

            if (outcomes.some((outcome) => outcome.isChatRefused)) {
                onRefused(threadId);
                setConfirmations((current) => current.filter((confirmation) => confirmation.threadId !== threadId));

                return;
            }

            const { ended, holdEnds, isRefreshDue } = tallyChecks(outcomes, confirmReads.current);

            if (ended.size > 0) {
                onEnded();
            }

            if (ended.size > 0 || holdEnds.size > 0) {
                setConfirmations((current) =>
                    current
                        .filter((confirmation) => !ended.has(confirmation.messageId))
                        .map((confirmation) => {
                            if (!holdEnds.has(confirmation.messageId)) {
                                return confirmation;
                            }

                            return { ...confirmation, holdsSend: false };
                        }),
                );
            }

            if (isRefreshDue) {
                // Re-reads the history: the server's copy of a settled reply, or of one still waiting, is shown.
                setConfirmTick((tick) => tick + 1);
            }
        };

        const timer = setInterval(check, CONFIRM_READ_INTERVAL_MS);

        return () => {
            isActive = false;
            clearInterval(timer);
        };
    }, [confirmations, fetchPage, onEnded, onRefused, threadId]);

    const addConfirmation = useCallback((confirmation: Confirmation) => {
        setConfirmations((current) => [...current, confirmation]);
    }, []);

    return { addConfirmation, confirmTick, isAwaitingReply };
};
