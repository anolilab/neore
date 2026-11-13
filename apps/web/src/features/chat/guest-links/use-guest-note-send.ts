import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { isSendStarting } from "@/features/chat/core/utils/send-in-flight";
import { useCRPC } from "@/lib/lunora/crpc";

/** How a note's Send ended: handed to the ordinary send, found already sent, or held for a reply that has begun. */
export type GuestNoteSendOutcome = "already-sent" | "busy" | "sent";

/**
 * A held note's Send, held by a component that outlives the share menu (`ThreadShareButton`): the review and the send that
 * follows still run when the menu closes mid-check, and `sendingId` (the note whose Send is armed, so its Dismiss stays off)
 * survives the menu opening again.
 */
const useGuestNoteSend = (
    threadId: string | undefined,
    turnRunning: boolean,
    onSendNote: (text: string, guestMessageId: string) => Promise<void>,
): { sendingId: string | undefined; sendNote: (messageId: string) => Promise<GuestNoteSendOutcome> } => {
    const crpc = useCRPC();
    const unlockProof = useUnlockProof(threadId);
    const review = useMutation(crpc.chat.guest_links.sendHeldGuestMessage.mutationOptions());
    const [sendingId, setSendingId] = useState<string>();
    // Read again once the review answers: a reply (a queued prompt's) can have started meanwhile.
    const turnRunningRef = useRef(turnRunning);

    useEffect(() => {
        turnRunningRef.current = turnRunning;
    }, [turnRunning]);

    const sendNote = async (messageId: string): Promise<GuestNoteSendOutcome> => {
        setSendingId(messageId);

        try {
            const result = await review.mutateAsync({ messageId: messageId as Id<"threadGuestMessages">, unlockProof });

            if (result.status === "sent") {
                return "already-sent";
            }

            // A reply started meanwhile, or another send in this thread has begun: sending now would start a second run
            // beside it. The note stays waiting.
            if (turnRunningRef.current || isSendStarting(threadId)) {
                return "busy";
            }

            // The note's id goes with this send only: a send that fails is retried by pressing Send again.
            await onSendNote(result.text, messageId);

            return "sent";
        } finally {
            setSendingId(undefined);
        }
    };

    return { sendingId, sendNote };
};

export default useGuestNoteSend;
