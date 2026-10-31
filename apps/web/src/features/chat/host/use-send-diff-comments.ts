"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import type { ComposeResult } from "./diff-comments";
import { composeDiffComments } from "./diff-comments";
import { useDiffCommentStore, useDiffDraft } from "./diff-comments-store";
import { sendHostMessage } from "./host-send";
import useHostSendErrorMessages from "./host-send-errors";

/**
 * One request id per composed message and thread, kept across components: a retry after a lost answer, from either
 * place the draft is shown, finds the first try instead of starting a second turn. A different text is a new message.
 */
const attempts = new Map<string, { id: string; text: string }>();

/**
 * Sends a thread's drafted diff comments as one message through the host composer's own send (`sendHostMessage`,
 * `POST /hosts/send`). The draft is cleared only once the backend has accepted the message, and only the comments
 * that were in it.
 */
const useSendDiffComments = (
    threadId: string,
): { comments: ReturnType<typeof useDiffDraft>; composed: ComposeResult; send: () => Promise<boolean>; sending: boolean } => {
    const comments = useDiffDraft(threadId);
    const messages = useHostSendErrorMessages();
    const [sending, setSending] = useState(false);
    const busy = useRef(false);
    const composed = composeDiffComments(comments);

    const send = async (): Promise<boolean> => {
        if (!composed.ok || busy.current) {
            return false;
        }

        const sent = comments.map((comment) => comment.id);
        const previous = attempts.get(threadId);
        const attempt = previous?.text === composed.text ? previous : { id: crypto.randomUUID(), text: composed.text };

        attempts.set(threadId, attempt);
        busy.current = true;
        setSending(true);

        const result = await sendHostMessage({ requestId: attempt.id, text: composed.text, threadId });

        busy.current = false;
        setSending(false);

        if (!result.ok) {
            toast.error(messages[result.error]);

            return false;
        }

        attempts.delete(threadId);
        useDiffCommentStore.getState().clear(threadId, sent);

        return true;
    };

    return { comments, composed, send, sending };
};

export default useSendDiffComments;
