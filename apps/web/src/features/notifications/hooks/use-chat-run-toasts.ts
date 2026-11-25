import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import type { AppError } from "@/lib/errors";

import type { ChatToastSettings, ToastMessage, WaitingCall } from "../lib/chat-toasts";
import { isChatToastOn, lastReplyFailed, replySettled, waitingApprovalIds, waitingCalls } from "../lib/chat-toasts";

/** How long a finished run waits for its reply to settle before its outcome is decided anyway. */
const SETTLE_MS = 2000;

/**
 * Whether a run that began in `runThread` belongs to `thread`. A run that began in a chat without a thread yet (a new chat) ends
 * in the thread that chat gets, so no thread id on the run matches any thread.
 */
const sameThread = (runThread: string | undefined, thread: string | undefined): boolean => runThread === undefined || runThread === thread;

/** The run marker of a browser-local reply, which has no gateway stream. */
export const LOCAL_BROWSER_REPLY_RUN = "local-browser-reply";
/** The run marker of a reply still streaming in the thread, before its gateway stream id is known (an edit or a regenerate). */
export const THREAD_REPLY_RUN = "thread-reply";

interface ChatRunToastsInput {
    /** The thread's live run (a gateway stream, or the local marker for a browser-local reply), `null` between runs. */
    activeStreamId: string | null;
    /** The chat's error state: set when a reply failed. */
    error: AppError | null;
    /** The thread's messages: a tool call that waits for the person, and the reply's own status. */
    messages: ReadonlyArray<ToastMessage>;
    /** Whether the thread's messages have fully loaded. Until then a snapshot is partial and cannot be the baseline. */
    messagesReady: boolean;
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
    /** A call started waiting during the run, and the run stopped for it: approving it starts a new run, not a finish. */
    waitedAtEnd: boolean;
}

/**
 * The in-app toasts for a chat run: failed, finished, and needs your input or approval. Each one is gated by its
 * setting (`chat-toasts.ts`); the notification record and any push are written by the backend regardless.
 *
 * Every toast fires on a transition, never on the first snapshot, so opening a thread does not re-announce it.
 */
const useChatRunToasts = ({ activeStreamId, error, messages, messagesReady, settings, threadId }: ChatRunToastsInput): void => {
    const { t } = useLingui();
    const run = useRef<RunState | undefined>(undefined);
    const ended = useRef<EndedRun | undefined>(undefined);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const lastError = useRef<AppError | null>(null);
    const approvals = useRef<{ newest: string | undefined; threadId: string | undefined } | undefined>(undefined);
    // Every call id seen waiting in this chat: a call is announced the first time it is seen, never again.
    const seenCalls = useRef(new Set<string>());
    // The stream a thread had when it was first observed: already running (or cached) then, so not a run to announce.
    // `withReply`: the thread already had a reply when it was first observed. Only then is its stream from before the open;
    // a new chat's first stream is its own first reply, and is announced.
    const streamAtOpen = useRef<{ streamId: string | null; threadId: string | undefined; withReply: boolean } | undefined>(undefined);
    const renderedThread = useRef<{ messages: ReadonlyArray<ToastMessage>; threadId: string | undefined }>({ messages, threadId });
    const staleMessages = useRef<ReadonlyArray<ToastMessage> | undefined>(undefined);
    // The newest inputs, for the settle timer, which fires outside any render.
    // The toast texts are translated here, in render, and only the strings are kept: the settle step runs outside any render.
    const copy = { failed: t`A chat reply failed`, finished: t`A chat reply finished` };
    const latest = useRef({ copy, error, messages, settings, threadId });

    useEffect(() => {
        latest.current = { copy, error, messages, settings, threadId };
    });

    // Decides the outcome of an ended run and shows its toast. Runs once per run: it clears the run first.
    // `runOnly` decides from the run's own state alone: the reply and the errors in the thread may already belong to a newer run.
    const settle = useCallback((runOnly = false): void => {
        const pending = ended.current;

        if (!pending) {
            return;
        }

        const { current } = latest;

        ended.current = undefined;
        clearTimeout(settleTimer.current);

        // A run that ended in another thread is not this thread's reply to classify.
        if (!sameThread(pending.threadId, current.threadId)) {
            return;
        }

        const errorDuringRun = !runOnly && current.error !== null && current.error !== pending.startError;

        if (pending.failed || errorDuringRun || (!runOnly && lastReplyFailed(current.messages))) {
            if (isChatToastOn(current.settings, "failed")) {
                toast.error(current.copy.failed);
            }

            return;
        }

        // A run that stopped to wait for the person is not finished. Only a call that started waiting during the run counts:
        // one already waiting when the run began is an older turn's, and does not stop this one.
        if (pending.waitedAtEnd || (!runOnly && waitingApprovalIds(current.messages).some((id) => !pending.startWaiting.has(id)))) {
            return;
        }

        if (isChatToastOn(current.settings, "finished")) {
            toast.success(current.copy.finished);
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
        }

        // An error with no run open is not a reply's failure: a send refused before its reply starts leaves no reply to report.
    }, [error, settle]);

    // A run starts and ends with its stream id. The outcome waits until the reply has settled (or the window passes).
    useEffect(() => {
        // A stream seen before the thread's messages are ready may be stale cache from an earlier visit: it is not a run to announce.
        // A browser-local reply has no cached stream to be stale, so it is tracked whether or not the messages are ready.
        if (activeStreamId && !messagesReady && !run.current && activeStreamId !== LOCAL_BROWSER_REPLY_RUN) {
            return;
        }

        // The stream the thread already had when it opened (possibly stale cache) is not a run to announce; a stream that starts later is.
        if (streamAtOpen.current?.threadId !== threadId) {
            streamAtOpen.current = { streamId: activeStreamId, threadId, withReply: messages.some((message) => message.role === "assistant") };
        }

        const opened = streamAtOpen.current;

        if (activeStreamId && opened?.withReply && opened.streamId === activeStreamId && !run.current) {
            return;
        }

        if (activeStreamId) {
            // The stream ended but its reply still streams: the run that is in progress continues until the reply settles.
            if (activeStreamId === THREAD_REPLY_RUN && run.current && run.current.threadId === threadId) {
                return;
            }

            // The real stream id of a reply already in progress is the same run, not a new one.
            if (run.current?.streamId === THREAD_REPLY_RUN && run.current.threadId === threadId && activeStreamId !== THREAD_REPLY_RUN) {
                run.current = { ...run.current, streamId: activeStreamId };

                return;
            }

            if (run.current?.streamId !== activeStreamId) {
                // A finished run still settling is decided now, from its own state: the reply and errors in the thread now belong to the new run.
                settle(true);
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

        if (!finished || !sameThread(finished.threadId, threadId)) {
            return;
        }

        ended.current = {
            failed: finished.failed,
            startError: finished.startError,
            startWaiting: finished.startWaiting,
            threadId,
            waitedAtEnd: waitingApprovalIds(messages).some((id) => !finished.startWaiting.has(id)),
        };

        if (replySettled(messages)) {
            settle();
        } else {
            settleTimer.current = setTimeout(settle, SETTLE_MS);
        }
    }, [activeStreamId, error, messages, messagesReady, settle, threadId]);

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

    // The list of the render before the last thread change: while it is still the one on screen, it is not the new thread's.
    useEffect(() => {
        if (renderedThread.current.threadId !== threadId) {
            staleMessages.current = renderedThread.current.messages;
        }

        renderedThread.current = { messages, threadId };
    });

    // A tool call that starts waiting for the person. The baseline is the thread's first fully loaded snapshot: a thread that
    // opens already waiting shows its card on screen, so it is not announced. A partial load is not a baseline, so the older
    // calls that arrive with the rest of the history are not announced either. A call that arrives after the baseline is.
    useEffect(() => {
        // Settings still loading: nothing is recorded yet, so a call is not marked seen while its setting is unknown.
        if (!messagesReady || settings === undefined || messages === staleMessages.current) {
            return;
        }

        const calls = waitingCalls(messages);
        const previous = approvals.current;
        const newest = messages[messages.length - 1]?.id;
        // A call is announced once: one already seen waiting in this chat (even in a cached snapshot before a reopen) is not new.
        // The key is the thread, the message and the call: providers reuse tool call ids, so the id alone is not enough.
        const keyOf = (call: WaitingCall): string => `${threadId ?? ""}|${call.messageId}|${call.toolCallId}`;
        const fresh = calls.filter((call) => !seenCalls.current.has(keyOf(call)));

        for (const call of calls) {
            seenCalls.current.add(keyOf(call));
        }

        approvals.current = { newest, threadId };

        if (!previous || previous.threadId !== threadId) {
            return;
        }

        // Older history loaded above the newest message the previous snapshot had is not a new call, even when it is still waiting.
        // A call inside that newest message is new when it was not waiting before: the reply it belongs to is still streaming.
        const anchor = previous.newest === undefined ? -1 : messages.findIndex((message) => message.id === previous.newest);
        const arrived = fresh.some((call) => call.index >= anchor);

        if (arrived && isChatToastOn(settings, "input")) {
            toast.warning(t`A chat needs your input or approval`);
        }
    }, [messages, messagesReady, settings, t, threadId]);
};

export default useChatRunToasts;
