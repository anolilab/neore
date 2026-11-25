import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import type { AppError } from "@/lib/errors";

import type { ChatToastSettings, ToastMessage } from "../lib/chat-toasts";
import { isChatToastOn, lastReplyFailed, replySettled, waitingApprovalIds } from "../lib/chat-toasts";

/** How long a finished run waits for its reply to settle before its outcome is decided anyway. */
const SETTLE_MS = 2000;

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

/** A run in progress. `startWaiting` and `startError` are what was already true when it began. */
interface RunState {
    failed: boolean;
    startError: AppError | null;
    startWaiting: ReadonlySet<string>;
    streamId: string;
    threadId: string | undefined;
}

/** A run whose stream ended, waiting for its reply to settle before a toast decides its outcome. */
interface EndedRun {
    failed: boolean;
    startError: AppError | null;
    startWaiting: ReadonlySet<string>;
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
    const run = useRef<RunState | undefined>(undefined);
    const ended = useRef<EndedRun | undefined>(undefined);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const lastError = useRef<AppError | null>(null);
    const approvals = useRef<{ ids: ReadonlySet<string>; threadId: string | undefined } | undefined>(undefined);
    // The newest inputs, for the settle timer, which fires outside any render.
    const latest = useRef({ error, messages, settings, t });

    useEffect(() => {
        latest.current = { error, messages, settings, t };
    });

    // Decides the outcome of an ended run and shows its toast. Runs once per run: it clears the run first.
    const settle = useCallback((): void => {
        const pending = ended.current;

        if (!pending) {
            return;
        }

        const { current } = latest;

        ended.current = undefined;
        clearTimeout(settleTimer.current);

        const errorDuringRun = current.error !== null && current.error !== pending.startError;

        if (pending.failed || errorDuringRun || lastReplyFailed(current.messages)) {
            if (isChatToastOn(current.settings, "failed")) {
                toast.error(current.t`A chat reply failed`);
            }

            return;
        }

        // A run that stopped to wait for the person is not finished. Only a call that started waiting during the run counts:
        // one already waiting when the run began is an older turn's, and does not stop this one.
        if (waitingApprovalIds(current.messages).some((id) => !pending.startWaiting.has(id))) {
            return;
        }

        if (isChatToastOn(current.settings, "finished")) {
            toast.success(current.t`A chat reply finished`);
        }
    }, []);

    // A reply that errors is a failure. During a run it is recorded and toasted when the run settles; after the run it is toasted now.
    // Declared before the run effect, so an error that arrives with the stream end is seen while the run is still open.
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

            return;
        }

        if (ended.current) {
            ended.current = { ...ended.current, failed: true };
            settle();

            return;
        }

        if (isChatToastOn(settings, "failed")) {
            toast.error(t`A chat reply failed`);
        }
    }, [error, settings, settle, t]);

    // A run starts and ends with its stream id. The outcome waits until the reply has settled (or the window passes).
    useEffect(() => {
        if (activeStreamId) {
            if (run.current?.streamId !== activeStreamId) {
                // A new run supersedes a finished one that is still settling: decide that one now.
                settle();
                run.current = {
                    failed: false,
                    startError: error,
                    startWaiting: new Set(waitingApprovalIds(messages)),
                    streamId: activeStreamId,
                    threadId,
                };
            }

            return;
        }

        const finished = run.current;

        run.current = undefined;

        if (!finished || finished.threadId !== threadId) {
            return;
        }

        ended.current = {
            failed: finished.failed,
            startError: finished.startError,
            startWaiting: finished.startWaiting,
            threadId,
        };

        if (replySettled(messages)) {
            settle();
        } else {
            settleTimer.current = setTimeout(settle, SETTLE_MS);
        }
    }, [activeStreamId, error, messages, settle, threadId]);

    // The reply settles on its own: decide the finished run as soon as the thread shows the reply is no longer streaming.
    useEffect(() => {
        if (ended.current && replySettled(messages)) {
            settle();
        }
    }, [messages, settle]);

    useEffect(
        () => () => {
            clearTimeout(settleTimer.current);
        },
        [],
    );

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
