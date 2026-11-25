import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { AppError } from "@/lib/errors";

import type { ChatToastSettings, ToastMessage } from "../lib/chat-toasts";
import { isChatToastOn, lastReplyFailed, waitingApprovalIds } from "../lib/chat-toasts";

interface ChatRunToastsInput {
    /** The thread's live run (a gateway stream, or the local marker for a browser-local reply), `null` between runs. */
    activeStreamId: string | null;
    /** The chat's error state: set when a reply failed. */
    error: AppError | null;
    /** The thread's messages: a tool call that waits for the person, and the reply's own status. */
    messages: ReadonlyArray<ToastMessage>;
    settings: ChatToastSettings | null | undefined;
    threadId: string | undefined;
}

/**
 * The in-app toasts for a chat run: failed, finished, and needs your input or approval. Each one is gated by its
 * setting (`chat-toasts.ts`); the notification record and any push are written by the backend regardless.
 *
 * Every toast fires on a transition, never on the first snapshot, so opening a thread does not re-announce it.
 */
const useChatRunToasts = ({ activeStreamId, error, messages, settings, threadId }: ChatRunToastsInput): void => {
    const { t } = useLingui();
    // The run in progress: whether it failed, and the thread it belongs to.
    const run = useRef<{ failed: boolean; streamId: string; threadId: string | undefined } | undefined>(undefined);
    const lastError = useRef<AppError | null>(null);
    const approvals = useRef<{ ids: ReadonlySet<string>; threadId: string | undefined } | undefined>(undefined);

    // A run starts and ends with its stream id. Ending without a failure is a finish, unless the run stopped to wait for the person.
    useEffect(() => {
        if (activeStreamId) {
            const previous = run.current;

            run.current = {
                failed: previous?.streamId === activeStreamId && previous.failed,
                streamId: activeStreamId,
                threadId,
            };

            return;
        }

        const ended = run.current;

        run.current = undefined;

        if (!ended || ended.threadId !== threadId || ended.failed) {
            return;
        }

        if (waitingApprovalIds(messages).length > 0) {
            return;
        }

        // A server-side failure ends the stream without the client error: its reply carries the error status instead.
        if (lastReplyFailed(messages)) {
            if (isChatToastOn(settings, "failed")) {
                toast.error(t`A chat reply failed`);
            }

            return;
        }

        if (isChatToastOn(settings, "finished")) {
            toast.success(t`A chat reply finished`);
        }
    }, [activeStreamId, messages, settings, t, threadId]);

    // A reply that errors is a failure, whether or not its stream is still open.
    useEffect(() => {
        if (error === lastError.current) {
            return;
        }

        lastError.current = error;

        if (!error) {
            return;
        }

        if (run.current) {
            run.current = { ...run.current, failed: true };
        }

        if (isChatToastOn(settings, "failed")) {
            toast.error(t`A chat reply failed`);
        }
    }, [error, settings, t]);

    // A tool call that starts waiting for the person. The first snapshot of a thread only records what is already waiting.
    // Every later arrival is announced: a repeated alert for an approval already on screen is harmless, a missed one is not.
    useEffect(() => {
        const ids = new Set(waitingApprovalIds(messages));
        const previous = approvals.current;

        approvals.current = { ids, threadId };

        if (!previous || previous.threadId !== threadId) {
            return;
        }

        const arrived = [...ids].some((id) => !previous.ids.has(id));

        if (arrived && isChatToastOn(settings, "input")) {
            toast.warning(t`A chat needs your input or approval`);
        }
    }, [messages, settings, t, threadId]);
};

export default useChatRunToasts;
