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
 * Transition rules: `core/utils/prompt-queue.ts`. Mount exactly once per thread
 * — two mounted runners would each drain an item per stream.
 */

import { Plural, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { ListOrderedIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useRef } from "react";

import { useChatActions, useChatError, useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { QueuedChatPrompt } from "@/features/chat/core/stores/prompt-queue-store";
import { selectThreadQueue, usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import { decideAutoSend } from "@/features/chat/core/utils/prompt-queue";

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

            void sendMessage(prompt.text, prompt.attachments);

            useChatUIStore.setState({ attachedReferences, composerAttachments, composerText });
        },
        [sendMessage],
    );
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
    const sendQueuedPrompt = useSendQueuedPrompt();

    // Restores a queue left in sessionStorage by a reload; it arrives paused.
    useEffect(() => {
        if (threadId) {
            usePromptQueueStore.getState().hydrate(threadId);
        }
    }, [threadId]);

    // Runner: act only on a streaming -> idle transition within the same thread.
    const observedRef = useRef({ isStreaming, threadId });

    useEffect(() => {
        const previous = observedRef.current;

        observedRef.current = { isStreaming, threadId };

        if (!threadId || previous.threadId !== threadId) {
            return;
        }

        const { queues, setPaused, shift } = usePromptQueueStore.getState();
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
            const next = shift(threadId);

            if (next) {
                sendQueuedPrompt(next);
            }
        }
    }, [error, isStreaming, sendQueuedPrompt, threadId]);

    const handleRemove = useCallback(
        (id: string) => {
            if (threadId) {
                usePromptQueueStore.getState().remove(threadId, id);
            }
        },
        [threadId],
    );

    const handleSendNext = useCallback(() => {
        if (!threadId) {
            return;
        }

        const { setPaused, shift } = usePromptQueueStore.getState();

        setPaused(threadId, false);

        const next = shift(threadId);

        if (next) {
            sendQueuedPrompt(next);
        }
    }, [sendQueuedPrompt, threadId]);

    if (queue.items.length === 0) {
        return null;
    }

    const count = queue.items.length;
    const willAutoSend = isStreaming && !queue.paused;
    const statusText = willAutoSend ? t`${count} queued — sends when the current reply finishes` : t`${count} queued`;

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
