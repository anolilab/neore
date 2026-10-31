"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import type { ComposeResult } from "./diff-comments";
import { composeDiffComments } from "./diff-comments";
import { useDiffCommentStore, useDiffDraft } from "./diff-comments-store";
import { finishSendAttempt, requestIdForAttempt } from "./diff-send-attempts";
import { sendHostMessage } from "./host-send";
import useHostSendErrorMessages from "./host-send-errors";

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
        const requestId = requestIdForAttempt(threadId, comments, composed.text);

        busy.current = true;
        setSending(true);

        const result = await sendHostMessage({ requestId, text: composed.text, threadId });

        busy.current = false;
        setSending(false);

        if (!result.ok) {
            toast.error(messages[result.error]);

            return false;
        }

        finishSendAttempt(threadId);
        useDiffCommentStore.getState().clear(threadId, sent);

        return true;
    };

    return { comments, composed, send, sending };
};

export default useSendDiffComments;
