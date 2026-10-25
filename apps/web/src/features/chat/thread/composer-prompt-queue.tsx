"use client";

/**
 * ComposerPromptQueue - messages submitted while a turn is streaming.
 *
 * Renders the queued prompts as removable chips above the input and drains the
 * queue: one prompt per finished stream, in order. A manual stop (the composer
 * pauses the queue before cancelling) or a stream that ends in an error leaves
 * the chips in place with a "Send next" button instead of auto-sending — as
 * does coming back to a thread whose stream finished while you were away, and
 * a queue restored from sessionStorage after a reload.
 *
 * Steered prompts (sent INTO the running reply, `chat/steering.ts`) sit here
 * too, marked as such, until the reply takes them — the stream reports their
 * ids delivered and their chips go. One still here when its turn to send comes
 * is withdrawn first: `withdrawn` (the reply never took it) sends it like any
 * queued prompt, `delivered` drops it. Removing its chip withdraws it too, so a
 * cancelled steer is not written into the reply. A steer or queued message
 * that lands after the reply ended (nothing will observe the stream end for it)
 * is sent straight away, through the same path.
 *
 * Transition rules: `core/utils/prompt-queue.ts`. Mount exactly once per thread
 * — two mounted runners would each drain an item per stream.
 */

import { Plural, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { CornerDownRightIcon, ListOrderedIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useRef } from "react";

import { useChatActions, useChatError, useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { QueuedChatPrompt } from "@/features/chat/core/stores/prompt-queue-store";
import { selectThreadQueue, usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import type { QueuedSteer, SteerWithdrawal } from "@/features/chat/core/utils/prompt-queue";
import { decideAutoSend, deliveredSteerItems, takeNextToSend } from "@/features/chat/core/utils/prompt-queue";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/**
 * `sendMessage` clears the composer synchronously (before its first await) —
 * right for a typed message, wrong for a queued one, because the composer now
 * holds the user's NEXT draft. Snapshot it around the call and put it back.
 */
const useSendQueuedPrompt = () => {
    const { sendMessage } = useChatActions();

    return useCallback(
        (prompt: QueuedChatPrompt) => {
            const { attachedReferences, composerAttachments, composerText } = useChatUIStore.getState();

            if (prompt.references) {
                useChatUIStore.setState({ attachedReferences: prompt.references });
            }

            void sendMessage(prompt.text, prompt.attachments);

            useChatUIStore.setState({ attachedReferences, composerAttachments, composerText });
        },
        [sendMessage],
    );
};

/**
 * The queue's two actions that may have to ask the server first: sending the
 * next prompt and removing a chip. A steered prompt is withdrawn from its run
 * (`chat_steering.withdrawSteer`) before either — it may sit in the run's queue
 * and be written into the reply otherwise — and its chip stays until that
 * answers, so a failure loses nothing and keeps the queue's order. One call at
 * a time: a second would act on a prompt the first is still settling.
 */
const useQueueActions = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const sendQueuedPrompt = useSendQueuedPrompt();
    const { threadId: currentThreadId } = useChatThread();
    const { isStreaming } = useChatIsStreaming();
    const { error } = useChatError();
    const { mutateAsync: withdrawSteer } = useMutation(crpc.chat.steering.withdrawSteer.mutationOptions());
    const busyRef = useRef(false);
    // What an `await` in here must re-read afterwards, not close over.
    const latestRef = useRef({ hasError: Boolean(error), isStreaming, threadId: currentThreadId });
    // A thread whose send was asked for while a removal held `busyRef`.
    const sendRequestedRef = useRef<string | undefined>(undefined);
    const sendNextPromptRef = useRef<(threadId: string, options?: { explicit?: boolean }) => Promise<void>>(async () => {});

    useEffect(() => {
        latestRef.current = { hasError: Boolean(error), isStreaming, threadId: currentThreadId };
    }, [currentThreadId, error, isStreaming]);

    const withdraw = useCallback(
        async (threadId: string, steer: QueuedSteer): Promise<SteerWithdrawal> => {
            const { outcome } = await withdrawSteer({
                steerId: steer.id,
                streamId: steer.streamId as Id<"persistentStreams">,
                threadId: threadId as Id<"threads">,
            });

            return outcome;
        },
        [withdrawSteer],
    );

    /**
     * Sends the thread's next prompt. One whose withdrawal failed stays first, and the queue pauses.
     * An automatic send leaves the queue for the user to review when the reply ended in an error,
     * even if that error arrived during the withdrawal; `explicit` (the Send next button) sends anyway.
     */
    const sendNextPrompt = useCallback(
        async (threadId: string, { explicit = false }: { explicit?: boolean } = {}): Promise<void> => {
            if (busyRef.current) {
                // Not dropped: the call that holds the flag runs it once it lets go.
                sendRequestedRef.current = threadId;

                return;
            }

            busyRef.current = true;

            try {
                const { remove, setPaused } = usePromptQueueStore.getState();
                const next = await takeNextToSend({
                    // A reply that started meanwhile owns the thread: a message sent from the
                    // composer is `isSubmitting` before its stream exists, so that counts too.
                    canSend: () => {
                        const latest = latestRef.current;

                        return latest.threadId === threadId && !latest.isStreaming && (explicit || !latest.hasError) && !useChatUIStore.getState().isSubmitting;
                    },
                    peek: () => usePromptQueueStore.getState().queues[threadId]?.items[0],
                    remove: (id) => remove(threadId, id),
                    withdraw: async (steer) => await withdraw(threadId, steer),
                });

                if (next?.kind === "send") {
                    sendQueuedPrompt(next.prompt);
                } else if (next?.kind === "failed") {
                    setPaused(threadId, true);
                }
            } finally {
                busyRef.current = false;
                // A send starts a reply, and the next one waits for its end.
                sendRequestedRef.current = undefined;
            }
        },
        [sendQueuedPrompt, withdraw],
    );

    useEffect(() => {
        sendNextPromptRef.current = sendNextPrompt;
    }, [sendNextPrompt]);

    /** After a removal: runs the send that was asked for meanwhile, if the thread still allows one. */
    const sendRequestedMeanwhile = useCallback(() => {
        const threadId = sendRequestedRef.current;

        sendRequestedRef.current = undefined;

        if (!threadId) {
            return;
        }

        const { hasError, isStreaming: streaming, threadId: shown } = latestRef.current;
        const queue = usePromptQueueStore.getState().queues[threadId];

        if (shown === threadId && !streaming && !hasError && queue && !queue.paused && queue.items.length > 0) {
            void sendNextPromptRef.current(threadId);
        }
    }, []);

    /** Removes a chip. A steered one leaves only once its run no longer holds the message. */
    const removePrompt = useCallback(
        async (threadId: string, id: string): Promise<void> => {
            const { remove } = usePromptQueueStore.getState();
            const prompt = usePromptQueueStore.getState().queues[threadId]?.items.find((item) => item.id === id);

            if (!prompt) {
                return;
            }

            if (!prompt.steer) {
                remove(threadId, id);

                return;
            }

            // Its call is still out: a withdrawal now could miss it, and the run would take it after all.
            if (busyRef.current || prompt.steer.pending) {
                return;
            }

            busyRef.current = true;

            try {
                // `delivered` is fine too: the reply has the message, so there is nothing left to cancel.
                await withdraw(threadId, prompt.steer);
                remove(threadId, id);
            } catch {
                showError(t`Could not cancel the message. It is still queued.`);
            } finally {
                busyRef.current = false;
                sendRequestedMeanwhile();
            }
        },
        [sendRequestedMeanwhile, t, withdraw],
    );

    return { removePrompt, sendNextPrompt };
};

const QueueChip: FC<{ onRemove: (id: string) => void; position: number; prompt: QueuedChatPrompt }> = ({ onRemove, position, prompt }) => {
    const { t } = useLingui();
    const preview = prompt.text.trim() || t`(attachments only)`;
    const attachmentCount = prompt.attachments.length;
    const droppedCount = prompt.droppedAttachments ?? 0;

    return (
        <li className="bg-muted/60 flex max-w-full min-w-0 items-center gap-1.5 rounded-full border py-0.5 pr-0.5 pl-2.5 text-xs">
            <span aria-hidden="true" className="text-muted-foreground tabular-nums">
                {position}.
            </span>
            {prompt.steer && (
                <span className="text-muted-foreground flex items-center">
                    <CornerDownRightIcon aria-hidden="true" className="size-3" />
                    <span className="sr-only">{t`Steering:`}</span>
                </span>
            )}
            <span className="max-w-64 truncate" title={prompt.text}>
                {preview}
            </span>
            {attachmentCount > 0 && (
                <span className="text-muted-foreground flex items-center gap-0.5">
                    <PaperclipIcon aria-hidden="true" className="size-3" />
                    <span className="sr-only">{t`Attachments:`}</span>
                    {attachmentCount}
                </span>
            )}
            {droppedCount > 0 && (
                <span className="text-muted-foreground italic">
                    <Plural one="# attachment removed on reload" other="# attachments removed on reload" value={droppedCount} />
                </span>
            )}
            <button
                aria-label={t`Remove queued message ${position}`}
                className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground rounded-full p-0.5"
                disabled={Boolean(prompt.steer?.pending)}
                onClick={() => onRemove(prompt.id)}
                type="button"
            >
                <XIcon aria-hidden="true" className="size-3" />
            </button>
        </li>
    );
};

const ComposerPromptQueue: FC = () => {
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const { isStreaming } = useChatIsStreaming();
    const { error } = useChatError();
    const queue = usePromptQueueStore(selectThreadQueue(threadId));
    const { removePrompt, sendNextPrompt } = useQueueActions();
    const crpc = useCRPC();
    // The same query (and key) the chat context reads, so no second subscription.
    const { data: activeStream } = useQuery(
        crpc.chat.streaming.getActiveStreamForThread.queryOptions(threadId && threadId !== "default" ? { threadId: threadId as Id<"threads"> } : skipToken),
    );

    // Restores a queue left in sessionStorage by a reload; it arrives paused.
    useEffect(() => {
        if (threadId) {
            usePromptQueueStore.getState().hydrate(threadId);
        }
    }, [threadId]);

    // A steered prompt the running reply has taken is in the thread now: retire its chip.
    useEffect(() => {
        const deliveredIds = activeStream?.deliveredSteerIds;

        if (!threadId || !activeStream || !deliveredIds?.length) {
            return;
        }

        const { remove } = usePromptQueueStore.getState();

        for (const id of deliveredSteerItems(queue.items, activeStream.streamId, deliveredIds)) {
            remove(threadId, id);
        }
    }, [activeStream, queue.items, threadId]);

    // Runner: act only on a streaming -> idle transition within the same thread.
    const observedRef = useRef({ isStreaming, threadId });

    useEffect(() => {
        const previous = observedRef.current;

        observedRef.current = { isStreaming, threadId };

        if (!threadId || previous.threadId !== threadId) {
            return;
        }

        const { queues, setPaused } = usePromptQueueStore.getState();
        const current = queues[threadId];
        const decision = decideAutoSend({
            hasError: Boolean(error),
            isStreaming,
            paused: current?.paused ?? false,
            queueLength: current?.items.length ?? 0,
            wasStreaming: previous.isStreaming,
        });

        if (decision === "pause") {
            setPaused(threadId, true);
        } else if (decision === "send") {
            void sendNextPrompt(threadId);
        }
    }, [error, isStreaming, sendNextPrompt, threadId]);

    // A message that joins the queue once the reply has already ended (a steer the
    // server accepted as the run finished, or one it refused for that reason) missed
    // the streaming -> idle transition above, so nothing else would send it. What was
    // queued before this thread mounted is not "new": coming back to an old queue
    // never sends by surprise.
    const seenRef = useRef<{ ids: Set<string>; pending: Set<string>; threadId: string | undefined }>({
        ids: new Set(),
        pending: new Set(),
        threadId: undefined,
    });

    useEffect(() => {
        const pendingNow = new Set(queue.items.filter((item) => item.steer?.pending).map((item) => item.id));

        if (seenRef.current.threadId !== threadId) {
            seenRef.current = { ids: new Set(queue.items.map((item) => item.id)), pending: pendingNow, threadId };

            return;
        }

        const { ids, pending } = seenRef.current;
        const arrived = queue.items.some((item) => !ids.has(item.id) && !pendingNow.has(item.id));
        // A steer whose call just answered: the queue was held at it, and the reply may be over by now.
        const settled = queue.items.some((item) => pending.has(item.id) && !pendingNow.has(item.id));

        for (const item of queue.items) {
            ids.add(item.id);
        }

        seenRef.current.pending = pendingNow;

        if (!isStreaming && !error && threadId && !queue.paused && (arrived || settled)) {
            void sendNextPrompt(threadId);
        }
    }, [error, isStreaming, queue.items, queue.paused, sendNextPrompt, threadId]);

    const handleRemove = useCallback(
        (id: string) => {
            if (threadId) {
                void removePrompt(threadId, id);
            }
        },
        [removePrompt, threadId],
    );

    const handleSendNext = useCallback(() => {
        if (!threadId) {
            return;
        }

        usePromptQueueStore.getState().setPaused(threadId, false);
        void sendNextPrompt(threadId, { explicit: true });
    }, [sendNextPrompt, threadId]);

    if (queue.items.length === 0) {
        return null;
    }

    const count = queue.items.length;
    const steerCount = queue.items.filter((item) => item.steer).length;
    const willAutoSend = isStreaming && !queue.paused;
    let statusText = willAutoSend ? t`${count} queued — sends when the current reply finishes` : t`${count} queued`;

    if (steerCount === count && isStreaming) {
        statusText = t`${count} steering — the reply reads it at its next step`;
    }

    return (
        <div className="mx-2 mt-2 flex flex-wrap items-center gap-1.5">
            <span aria-live="polite" className="text-muted-foreground flex items-center gap-1 text-xs" role="status">
                <ListOrderedIcon aria-hidden="true" className="size-3.5" />
                {statusText}
            </span>
            <ol aria-label={t`Queued messages`} className="flex min-w-0 flex-wrap gap-1.5">
                {queue.items.map((prompt, index) => (
                    <QueueChip key={prompt.id} onRemove={handleRemove} position={index + 1} prompt={prompt} />
                ))}
            </ol>
            {!isStreaming && (
                <Button className="h-6 gap-1 px-2 text-xs" onClick={handleSendNext} size="sm" type="button" variant="outline">
                    <SendIcon aria-hidden="true" className="size-3" />
                    {t`Send next`}
                </Button>
            )}
        </div>
    );
};

export default ComposerPromptQueue;
