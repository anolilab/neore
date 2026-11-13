import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useChatIsStreaming } from "@/features/chat/core/context/chat-context-hooks";
import type { SendOutcome } from "@/features/chat/core/context/send-message";
import { isSendStarting } from "@/features/chat/core/utils/send-in-flight";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * How a note's Send ended: its send started; found already sent; held for a reply that has begun; the owner asked to sign in
 * first; or failed, with the message to show (`/chat/start`'s refusal in the app's words; none for no reason in particular).
 */
export type GuestNoteSendOutcome = { kind: "already-sent" | "busy" | "sent" | "sign-in" } | { kind: "failed"; message?: string };

/**
 * A held note's Send, held by a component that outlives the share menu (`ThreadShareButton`): the review and the send that
 * follows still run when the menu closes mid-check, and `sendingId` (the note whose Send is armed, so its Dismiss stays off)
 * survives the menu opening again. `turnRunning`: a reply runs in this thread, not a local one still streaming in a chat left
 * behind.
 */
const useGuestNoteSend = (
    threadId: string | undefined,
    onSendNote: (text: string, guestMessageId: string) => Promise<SendOutcome>,
): { sendingId: string | undefined; sendNote: (messageId: string) => Promise<GuestNoteSendOutcome>; turnRunning: boolean } => {
    const { isThreadStreaming: turnRunning } = useChatIsStreaming();
    const crpc = useCRPC();
    const unlockProof = useUnlockProof(threadId);
    const review = useMutation(crpc.chat.guest_links.sendHeldGuestMessage.mutationOptions());
    const [sendingId, setSendingId] = useState<string>();
    // Read again once the review answers: a reply (a queued prompt's) can have started meanwhile, or the owner moved to another
    // chat, whose state says nothing of the note's (`threadId` undefined once this hook is gone).
    const shownRef = useRef<{ threadId: string | undefined; turnRunning: boolean }>({ threadId, turnRunning });

    useEffect(() => {
        shownRef.current = { threadId, turnRunning };
    }, [threadId, turnRunning]);

    useEffect(
        () => () => {
            shownRef.current = { threadId: undefined, turnRunning: false };
        },
        [],
    );

    const sendNote = async (messageId: string): Promise<GuestNoteSendOutcome> => {
        // The note's own thread: the send below (`onSendNote`, from this render) goes there.
        const noteThreadId = threadId;

        setSendingId(messageId);

        try {
            const result = await review.mutateAsync({ messageId: messageId as Id<"threadGuestMessages">, unlockProof });

            if (result.status === "sent") {
                return { kind: "already-sent" };
            }

            // A reply started meanwhile in the note's thread, or another send there has begun: sending now would start a second
            // run beside it. Its state is known only while it is the chat shown; after a move to another chat the note stays
            // waiting too, to be sent from its own chat.
            const shown = shownRef.current;

            if (shown.threadId !== noteThreadId || shown.turnRunning || isSendStarting(noteThreadId)) {
                return { kind: "busy" };
            }

            // The note's id goes with this send only: a send that fails is retried by pressing Send again. Sent only once the
            // gateway took it; a refusal or a timeout comes back as such.
            const sent = await onSendNote(result.text, messageId);

            if (sent.started) {
                return { kind: "sent" };
            }

            return sent.signIn === true ? { kind: "sign-in" } : { kind: "failed", message: sent.failure };
        } finally {
            setSendingId(undefined);
        }
    };

    return { sendingId, sendNote, turnRunning };
};

export default useGuestNoteSend;
