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
 * A chip moves up or down with its buttons (the keyboard path) or by dragging it
 * to a new place; either way the store keeps the order and mirrors it to
 * sessionStorage.
 *
 * Transition rules: `core/utils/prompt-queue.ts`. Mount exactly once per thread
 * — two mounted runners would each drain an item per stream.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plural, useLingui } from "@lingui/react/macro";
import { MAX_PROMPT_CHARS } from "@neore/ai/constants";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    ChevronDownIcon,
    ChevronUpIcon,
    CornerDownRightIcon,
    GripVerticalIcon,
    ListOrderedIcon,
    PaperclipIcon,
    PencilIcon,
    SendIcon,
    XIcon,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { FC, ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useChatActions, useChatError, useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { QueuedChatPrompt } from "@/features/chat/core/stores/prompt-queue-store";
import { allowPromptQueueRestore, selectThreadQueue, usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import type { HeldSend } from "@/features/chat/core/stores/queue-edit-store";
import { selectThreadEdit, useQueueEditStore } from "@/features/chat/core/stores/queue-edit-store";
import type { QueuedSteer, SteerWithdrawal } from "@/features/chat/core/utils/prompt-queue";
import { cleanPromptText, decideAutoSend, deliveredSteerItems, takeNextToSend } from "@/features/chat/core/utils/prompt-queue";
import { isSendStarting, subscribeSendStarting } from "@/features/chat/core/utils/send-in-flight";
import { useConnectionView } from "@/features/connection/hooks/use-connection";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";
import { showError, showInfo } from "@/lib/toast";

import { permissionModeSaveKey, usePermissionModeSaving } from "./composer-permission-mode";

/**
 * Whether the thread's head is being edited in its chip. The drain holds its send then: the send would take the old
 * text and discard the unsaved correction. The hold ends with the edit (Save or Cancel), and the queue goes on.
 */
const headIsBeingEdited = (threadId: string): boolean => {
    const head = usePromptQueueStore.getState().queues[threadId]?.items[0];
    const edit = useQueueEditStore.getState().editing[threadId];

    return head !== undefined && edit?.id === head.id;
};

/**
 * The one rule every release path follows for a held send: the edit's close, a reply's end or a chat's switch-in, and a
 * permission-mode save's end. It answers whether the hold may go now, and the send itself clears the hold once its message
 * is sent (a blocked send leaves the hold in place):
 * - unpaused: it may go, with its intent;
 * - paused by a chat error and explicit: the pause is lifted and it may go, as Send next does;
 * - anything else (a failed save's pause, a Stop, an automatic send behind an error): it stays held.
 * A queue seen unpaused drops any failed-save mark, which described a pause that has ended.
 */
const releasableHeldSend = (threadId: string, hasError: boolean): HeldSend | undefined => {
    const store = useQueueEditStore.getState();
    // Read live, not from a render: a pause set earlier in the same commit (a reply's error) must count here.
    const paused = usePromptQueueStore.getState().queues[threadId]?.paused === true;

    if (!paused && store.failedSave[threadId] === true) {
        store.markFailedSave(threadId, false);
    }

    const held = store.held[threadId];

    if (held === undefined) {
        return undefined;
    }

    // A hold names its message: while that message is not the head, the hold waits for its own release and sends nothing else.
    const head = usePromptQueueStore.getState().queues[threadId]?.items[0];

    if (held.id !== undefined && held.id !== head?.id) {
        return undefined;
    }

    if (paused) {
        // Only a reply's error pause lifts, and never a failed save's: a Stop, a rate limit or a refused send keeps the hold.
        const liftable = held.explicit && hasError && store.errorPaused[threadId] === true && store.failedSave[threadId] !== true;

        if (!liftable) {
            return undefined;
        }

        usePromptQueueStore.getState().setPaused(threadId, false);
    }

    return held;
};

/**
 * `sendMessage` clears the composer synchronously (before its first await) —
 * right for a typed message, wrong for a queued one, because the composer now
 * holds the user's NEXT draft. Snapshot it around the call and put it back.
 */
const useSendQueuedPrompt = () => {
    const { sendMessage } = useChatActions();

    return useCallback(
        (prompt: QueuedChatPrompt) => {
            const { attachedReferences, composerAttachments, composerDraftFrom, composerText } = useChatUIStore.getState();

            if (prompt.references) {
                useChatUIStore.setState({ attachedReferences: prompt.references });
            }

            void sendMessage(prompt.text, prompt.attachments, { draftFrom: prompt.draftFrom });

            useChatUIStore.setState({ attachedReferences, composerAttachments, composerDraftFrom, composerText });
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
    const queryClient = useQueryClient();
    const { mutateAsync: withdrawSteer } = useMutation(crpc.chat.steering.withdrawSteer.mutationOptions());
    const offline = useConnectionView() === "offline";
    const busyRef = useRef(false);
    // What an `await` in here must re-read afterwards, not close over.
    const latestRef = useRef({ hasError: Boolean(error), isStreaming, offline, threadId: currentThreadId });
    // A thread whose send was asked for while a removal held `busyRef`; `explicit` is the Send next button, which outranks a reply's error.
    const sendRequestedRef = useRef<{ explicit: boolean; threadId: string } | undefined>(undefined);
    // Chips whose removal was asked for while another call held `busyRef`.
    const removalsRequestedRef = useRef<{ id: string; threadId: string }[]>([]);
    const holdOffline = useCallback(
        (threadId: string, explicit: boolean) => {
            usePromptQueueStore.getState().holdOffline(threadId, explicit);

            // The Send next button says why nothing moved, as the composer does for a send offline.
            if (explicit) {
                showInfo(t`You are offline. Your message stays here; send it once you are back online.`, { id: "composer-offline-send" });
            }
        },
        [t],
    );
    const removePromptRef = useRef<(threadId: string, id: string) => Promise<void>>(async () => {});
    const sendNextPromptRef = useRef<(threadId: string, options?: { explicit?: boolean }) => Promise<void>>(async () => {});

    // Threads whose send was held only because another send there had begun (`explicit` as asked): that send's end tries again.
    const deferredRef = useRef(new Map<string, boolean>());
    // That end, waiting for the render after it: a reply the send started reads as streaming there, an error as an error.
    const [released, setReleased] = useState<{ explicit: boolean; threadId: string }>();

    const deferBehindStartingSend = useCallback((threadId: string, explicit: boolean): boolean => {
        if (!isSendStarting(threadId)) {
            return false;
        }

        deferredRef.current.set(threadId, explicit || deferredRef.current.get(threadId) === true);

        return true;
    }, []);

    useEffect(() => {
        latestRef.current = { hasError: Boolean(error), isStreaming, offline, threadId: currentThreadId };
    }, [currentThreadId, error, isStreaming, offline]);

    // Only the thread whose send was held, and only when it was held: never a queue another thread's send never touched.
    useEffect(
        () =>
            subscribeSendStarting(({ refused, threadId }) => {
                const explicit = deferredRef.current.get(threadId);

                // A refused send (banned words) went back to the composer to be fixed: the queue waits for the owner (Send next,
                // or resume), as after an error. Paused now, before the streaming -> idle that follows reads as a plain end.
                if (refused) {
                    deferredRef.current.delete(threadId);

                    const { queues, setPaused } = usePromptQueueStore.getState();

                    if ((queues[threadId]?.items.length ?? 0) > 0) {
                        setPaused(threadId, true);
                    }

                    return;
                }

                if (explicit === undefined) {
                    return;
                }

                deferredRef.current.delete(threadId);
                setReleased({ explicit, threadId });
            }),
        [],
    );

    /** Once `busyRef` is free: runs the removals asked for meanwhile, one after the other (each re-queues the rest while it holds the flag). */
    const removeRequestedMeanwhile = useCallback(() => {
        const requested = removalsRequestedRef.current;

        removalsRequestedRef.current = [];

        for (const { id, threadId } of requested) {
            void removePromptRef.current(threadId, id);
        }
    }, []);

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

    /** Once `busyRef` is free: runs the send that was asked for meanwhile, if the thread still allows one. */
    const sendRequestedMeanwhile = useCallback(() => {
        const requested = sendRequestedRef.current;

        sendRequestedRef.current = undefined;

        if (!requested) {
            return;
        }

        const { explicit, threadId } = requested;

        const { hasError, isStreaming: streaming, threadId: shown } = latestRef.current;
        const queue = usePromptQueueStore.getState().queues[threadId];

        if (shown === threadId && !streaming && queue && !queue.paused && queue.items.length > 0 && (explicit || !hasError)) {
            void sendNextPromptRef.current(threadId, { explicit });
        }
    }, []);

    /**
     * Once online with `busyRef` free: runs the shown thread's send that waited for the network. While another call holds
     * the flag it stays held, and that call runs it when it lets go — its own `finally` must not swallow it.
     */
    const replayOfflineHold = useCallback(() => {
        const { isStreaming: streaming, offline: isOffline, threadId } = latestRef.current;

        // While a reply streams the hold stays where it is: the runner takes it once that reply ends.
        if (isOffline || busyRef.current || streaming || !threadId) {
            return;
        }

        const held = usePromptQueueStore.getState().takeOfflineHold(threadId);

        if (held) {
            sendRequestedRef.current = { explicit: held.explicit, threadId };
            sendRequestedMeanwhile();
        }
    }, [sendRequestedMeanwhile]);

    /**
     * Sends the thread's next prompt. One whose withdrawal failed stays first, and the queue pauses.
     * An automatic send leaves the queue for the user to review when the reply ended in an error,
     * even if that error arrived during the withdrawal; `explicit` (the Send next button) sends anyway.
     */
    const sendNextPrompt = useCallback(
        async (threadId: string, { explicit = false }: { explicit?: boolean } = {}): Promise<void> => {
            if (latestRef.current.offline) {
                holdOffline(threadId, explicit);

                return;
            }

            if (busyRef.current) {
                // Not dropped: the call that holds the flag runs it once it lets go.
                sendRequestedRef.current = { explicit: explicit || sendRequestedRef.current?.explicit === true, threadId };

                return;
            }

            busyRef.current = true;
            // Whether this call sent a prompt: its reply has not started in the rendered state yet, so nothing else may send now.
            let sent = false;

            try {
                const { remove, settleSteer, setPaused } = usePromptQueueStore.getState();
                const next = await takeNextToSend({
                    // A reply that started meanwhile owns the thread: a message sent from the
                    // composer is `isSubmitting` before its stream exists, so that counts too.
                    canSend: () => {
                        // The head's text is open in its chip: the send is held with its intent, and the edit's close sends it
                        // with its own text (the close effect takes the held send; nothing else sends it under the editor).
                        if (headIsBeingEdited(threadId)) {
                            useQueueEditStore.getState().holdSend(threadId, explicit, usePromptQueueStore.getState().queues[threadId]?.items[0]?.id);

                            return false;
                        }

                        const latest = latestRef.current;

                        return (
                            latest.threadId === threadId &&
                            !latest.isStreaming &&
                            // Paused meanwhile (Stop, a refused send): Send next resumes the queue before it sends, so this holds only
                            // a pause that came after the send was asked for.
                            !usePromptQueueStore.getState().queues[threadId]?.paused &&
                            // The withdrawal's await can outlast the network: then the prompt stays and is held for it.
                            !latest.offline &&
                            // Read from the cache, not the rendered flag: a save that began after the last render is not in that flag yet,
                            // and this check runs after the withdrawal's await, so it could send under the old mode.
                            queryClient.isMutating({ exact: true, mutationKey: permissionModeSaveKey(threadId) }) === 0 &&
                            (explicit || !latest.hasError) &&
                            !useChatUIStore.getState().isSubmitting &&
                            // Another send (a guest note's, say) has begun and its reply is not streaming yet: its end tries
                            // again (`deferredRef`).
                            !deferBehindStartingSend(threadId, explicit)
                        );
                    },
                    peek: () => usePromptQueueStore.getState().queues[threadId]?.items[0],
                    plain: ({ steer }) => {
                        if (steer) {
                            settleSteer(threadId, steer.id, "refused");
                        }
                    },
                    remove: (id) => remove(threadId, id),
                    withdraw: async (steer) => await withdraw(threadId, steer),
                });

                if (next?.kind === "send") {
                    sent = true;
                    // It went: nothing waits for the send that held it any more, and no hold it left may send later.
                    deferredRef.current.delete(threadId);
                    // Only a hold for this message is fulfilled by its send; another message's hold waits for its own release.
                    const heldNow = useQueueEditStore.getState().held[threadId];

                    if (heldNow !== undefined && (heldNow.id === undefined || heldNow.id === next.prompt.id)) {
                        useQueueEditStore.getState().takeHeldSend(threadId);
                    }

                    sendQueuedPrompt(next.prompt);
                } else if (next?.kind === "failed") {
                    setPaused(threadId, true);
                } else if (next?.kind === "blocked" && latestRef.current.offline) {
                    holdOffline(threadId, explicit);
                }
            } finally {
                busyRef.current = false;

                // A send starts a reply, and the next one waits for its end: requests made meanwhile are dropped then.
                if (sent) {
                    sendRequestedRef.current = undefined;
                }

                removeRequestedMeanwhile();
                // A send asked for meanwhile, when this call sent nothing, runs now (as a removal's does), instead of being lost.
                sendRequestedMeanwhile();

                // A held send waits for this one's reply to end, like any other: it stays held until then.
                if (!sent) {
                    replayOfflineHold();
                }
            }
        },
        [deferBehindStartingSend, holdOffline, queryClient, removeRequestedMeanwhile, replayOfflineHold, sendQueuedPrompt, sendRequestedMeanwhile, withdraw],
    );

    useEffect(() => {
        sendNextPromptRef.current = sendNextPrompt;
    }, [sendNextPrompt]);

    // Runs once per release: `latestRef` was refreshed above in this same commit, and `sendNextPrompt` checks it.
    const handledReleaseRef = useRef(released);

    useEffect(() => {
        if (released === undefined || handledReleaseRef.current === released) {
            return;
        }

        handledReleaseRef.current = released;

        if (!usePromptQueueStore.getState().queues[released.threadId]?.paused) {
            void sendNextPrompt(released.threadId, { explicit: released.explicit });
        }
    }, [released, sendNextPrompt]);

    // Back online, or back on a thread whose send waited for the network while it was away: that send goes now.
    useEffect(() => {
        if (!offline) {
            replayOfflineHold();
        }
    }, [currentThreadId, offline, replayOfflineHold]);

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
            if (prompt.steer.pending) {
                return;
            }

            // Another call is settling the queue: not dropped, the call that holds the flag runs it once it lets go.
            if (busyRef.current) {
                removalsRequestedRef.current.push({ id, threadId });

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
                removeRequestedMeanwhile();
                sendRequestedMeanwhile();
                replayOfflineHold();
            }
        },
        [removeRequestedMeanwhile, replayOfflineHold, sendRequestedMeanwhile, t, withdraw],
    );

    useEffect(() => {
        removePromptRef.current = removePrompt;
    }, [removePrompt]);

    return { removePrompt, sendNextPrompt };
};

const QueueChip: FC<{
    /** A pending steer sits directly above or below: a move that way would pass over it, which the queue refuses. */
    blockedDown: boolean;
    blockedUp: boolean;
    count: number;
    /** The draft of this chip's open editor; undefined while the message is not being edited. Kept by the queue's edit store. */
    editDraft: string | undefined;
    /** Another message's editor is open: this one's Edit waits for it, so its draft is not replaced. */
    editLocked: boolean;
    onEdit: (id: string, text: string) => void;
    onEditDraft: (id: string, draft: string) => void;
    onEditStart: (id: string, text: string) => void;
    onEditStop: (id: string) => void;
    onMove: (id: string, step: -1 | 1) => void;
    onRemove: (id: string) => void;
    position: number;
    prompt: QueuedChatPrompt;
}> = ({ blockedDown, blockedUp, count, editDraft, editLocked, onEdit, onEditDraft, onEditStart, onEditStop, onMove, onRemove, position, prompt }) => {
    const { t } = useLingui();
    const pending = Boolean(prompt.steer?.pending);
    // A steered message keeps its place in the order the reply reads it, so it cannot be dragged, moved or edited.
    const fixed = Boolean(prompt.steer);
    const editing = editDraft !== undefined;
    const draft = editDraft ?? "";
    const blank = cleanPromptText(draft) === "";
    const blankHintId = useId();
    const { isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
        disabled: fixed || editing,
        id: prompt.id,
    });
    // Reduced motion: the chip still moves, without the sliding transition.
    const reduceMotion = useReducedMotion();
    const preview = prompt.text.trim() || t`(attachments only)`;
    const attachmentCount = prompt.attachments.length;
    const droppedCount = prompt.droppedAttachments ?? 0;

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Focus moves into the text when editing opens (not `autoFocus`, which the a11y rules refuse). A chip that mounts with its
    // editor already open (a remount) keeps focus where it is.
    const wasEditingRef = useRef(editing);

    useEffect(() => {
        if (editing && !wasEditingRef.current) {
            textareaRef.current?.focus();
        }

        wasEditingRef.current = editing;
    }, [editing]);

    const startEdit = (): void => {
        onEditStart(prompt.id, prompt.text);
    };

    const saveEdit = (): void => {
        // Text that is only hidden characters is no message: the editor stays open, as the disabled Save button shows.
        if (blank) {
            return;
        }

        // The stop comes first: a saved change hands the message a new id, and focus follows the id the message has then.
        onEditStop(prompt.id);
        onEdit(prompt.id, draft);
    };

    return (
        <li
            className={cn(
                "bg-muted/60 flex max-w-full min-w-0 items-center gap-1.5 border py-0.5 pr-0.5 pl-2.5 text-xs",
                editing ? "rounded-xl" : "rounded-full",
                isDragging && "opacity-50",
            )}
            data-queue-chip-id={prompt.id}
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition: reduceMotion ? undefined : transition }}
        >
            <span aria-hidden="true" className="text-muted-foreground tabular-nums">
                {position}.
            </span>
            {/* The only drag surface: `touch-none` keeps a touch drag from scrolling the page, and the buttons stay free for taps. */}
            {!fixed && !editing && (
                <span aria-hidden="true" className="text-muted-foreground flex cursor-grab touch-none items-center" ref={setActivatorNodeRef} {...listeners}>
                    <GripVerticalIcon className="size-3" />
                </span>
            )}
            {prompt.steer && (
                <span className="text-muted-foreground flex items-center">
                    <CornerDownRightIcon aria-hidden="true" className="size-3" />
                    <span className="sr-only">{t`Steering:`}</span>
                </span>
            )}
            {editing ? (
                <textarea
                    aria-describedby={blank ? blankHintId : undefined}
                    aria-label={t`Edit queued message ${position}`}
                    className="bg-background min-w-0 flex-1 resize-y rounded-md border px-1.5 py-1 text-xs"
                    // The composer's own cap: a longer text would be refused by the gateway after its chip had left the queue.
                    maxLength={MAX_PROMPT_CHARS}
                    onChange={(event) => {
                        onEditDraft(prompt.id, event.target.value);
                    }}
                    onKeyDown={(event) => {
                        // Keys that finish an IME composition (Escape, Enter) belong to the input method, not the editor.
                        if (event.nativeEvent.isComposing) {
                            return;
                        }

                        if (event.key === "Escape") {
                            event.preventDefault();
                            onEditStop(prompt.id);
                        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            saveEdit();
                        }
                    }}
                    ref={textareaRef}
                    rows={2}
                    // The native shell turns spellcheck off by default; an edited message is prose, so it keeps it.
                    spellCheck
                    value={draft}
                />
            ) : (
                <span className="max-w-64 truncate" title={prompt.text}>
                    {preview}
                </span>
            )}
            {attachmentCount > 0 && !editing && (
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
            {editing ? (
                <>
                    {blank && (
                        <span className="sr-only" id={blankHintId}>
                            {t`Type some visible text to save this message.`}
                        </span>
                    )}
                    <Button
                        aria-describedby={blank ? blankHintId : undefined}
                        className="h-6 px-2 text-xs pointer-coarse:min-h-11"
                        disabled={blank}
                        onClick={saveEdit}
                        size="sm"
                        type="button"
                    >
                        {t`Save`}
                    </Button>
                    <Button
                        className="h-6 px-2 text-xs pointer-coarse:min-h-11"
                        onClick={() => {
                            onEditStop(prompt.id);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        {t`Cancel`}
                    </Button>
                </>
            ) : (
                <>
                    <button
                        aria-label={t`Edit queued message ${position}`}
                        className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground flex size-6 items-center justify-center rounded-full disabled:opacity-40 pointer-coarse:size-11"
                        data-edit=""
                        disabled={fixed || editLocked}
                        onClick={startEdit}
                        type="button"
                    >
                        <PencilIcon aria-hidden="true" className="size-3" />
                    </button>
                    <button
                        aria-label={t`Move queued message ${position} up`}
                        className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground flex size-6 items-center justify-center rounded-full disabled:opacity-40 pointer-coarse:size-11"
                        data-move-up=""
                        disabled={fixed || position === 1 || blockedUp}
                        onClick={() => onMove(prompt.id, -1)}
                        type="button"
                    >
                        <ChevronUpIcon aria-hidden="true" className="size-3" />
                    </button>
                    <button
                        aria-label={t`Move queued message ${position} down`}
                        className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground flex size-6 items-center justify-center rounded-full disabled:opacity-40 pointer-coarse:size-11"
                        data-move-down=""
                        disabled={fixed || position === count || blockedDown}
                        onClick={() => onMove(prompt.id, 1)}
                        type="button"
                    >
                        <ChevronDownIcon aria-hidden="true" className="size-3" />
                    </button>
                    <button
                        aria-label={t`Remove queued message ${position}`}
                        className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground rounded-full p-0.5 pointer-coarse:size-11"
                        disabled={pending}
                        onClick={() => onRemove(prompt.id)}
                        type="button"
                    >
                        <XIcon aria-hidden="true" className="size-3" />
                    </button>
                </>
            )}
        </li>
    );
};

const ComposerPromptQueue: FC = () => {
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const { isStreaming } = useChatIsStreaming();
    const { error } = useChatError();
    const queue = usePromptQueueStore(selectThreadQueue(threadId));
    const edit = useQueueEditStore(selectThreadEdit(threadId));
    // A send held for this thread: only then does the status promise a send on the edit's close.
    const heldSend = useQueueEditStore((state) => (threadId === undefined ? undefined : state.held[threadId]));
    // The head's text is open in its chip: the queue holds its send until the edit closes (see `headIsBeingEdited`).
    const editOpen = edit !== undefined;
    const headEditing = editOpen && queue.items[0]?.id === edit.id;
    // Kept with its thread: a switch of chats must not read the previous thread's edit as this one's close.
    const wasHeadEditing = useRef<{ editing: boolean; threadId: string | undefined }>({ editing: edit !== undefined, threadId });
    const { removePrompt, sendNextPrompt } = useQueueActions();
    const modeSaving = usePermissionModeSaving(threadId);
    const wasModeSaving = useRef(modeSaving);
    const crpc = useCRPC();
    // The same query (and key) the chat context reads, so no second subscription.
    const { data: activeStream } = useQuery(
        crpc.chat.streaming.getActiveStreamForThread.queryOptions(threadId && threadId !== "default" ? { threadId: threadId as Id<"threads"> } : skipToken),
    );

    // Not before Lunora confirms the session: the chat layout paints before that (`OptimisticAuthGate`), and a queue
    // left by a session that has since ended is not this visitor's to read.
    const { isAuthenticated } = useLunoraAuth();

    // Restores a queue left in sessionStorage by a reload; it arrives paused.
    useEffect(() => {
        if (!threadId || !isAuthenticated) {
            return;
        }

        allowPromptQueueRestore();
        usePromptQueueStore.getState().hydrate(threadId);
    }, [isAuthenticated, threadId]);

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

        const { queues, setPaused, takeOfflineHold } = usePromptQueueStore.getState();

        // A Send next asked for offline waited for this reply: it goes now, as asked (an explicit one even after an error).
        // Not into a queue paused since, and an automatic one not after an error: the usual decision below pauses it then.
        if (previous.isStreaming && !isStreaming) {
            const held = takeOfflineHold(threadId);

            if (held && !(queues[threadId]?.paused ?? false) && (held.explicit || !error)) {
                void sendNextPrompt(threadId, { explicit: held.explicit });

                return;
            }
        }

        const current = queues[threadId];
        const decision = decideAutoSend({
            hasError: Boolean(error),
            isStreaming,
            paused: current?.paused ?? false,
            queueLength: current?.items.length ?? 0,
            wasStreaming: previous.isStreaming,
        });

        if (decision === "pause") {
            // A reply that ended in an error: the one pause an explicit held send may lift (a Stop or a rate limit is not).
            setPaused(threadId, true, true);
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

    // A save that ends releases the prompts that waited for it, unless the thread is busy, failed, or paused.
    useEffect(() => {
        const ended = wasModeSaving.current && !modeSaving;

        wasModeSaving.current = modeSaving;

        if (ended && threadId && !isStreaming && queue.items.length > 0) {
            // A send held while the save ran goes now, under the shared release rule.
            const held = releasableHeldSend(threadId, Boolean(error));

            if (held) {
                void sendNextPrompt(threadId, { explicit: held.explicit });

                return;
            }
        }

        if (ended && threadId && !isStreaming && !error && !queue.paused && queue.items.length > 0) {
            void sendNextPrompt(threadId);
        }
    }, [error, isStreaming, modeSaving, queue.items.length, queue.paused, sendNextPrompt, threadId]);

    // A send the queue held while the head's text was open goes once the edit closes, with its own intent. Only a held send
    // is retried: an edit that closes with nothing held changes nothing, and the queue's other rules still apply to the send.
    useEffect(() => {
        const previous = wasHeadEditing.current;
        // Closed is the edit record ending, not the edited message leaving the head: a chip moved ahead of it does not close it.
        const closed = previous.threadId === threadId && previous.editing && !editOpen;

        wasHeadEditing.current = { editing: editOpen, threadId };

        // While a reply streams, the held send waits for that reply's end (the effect below takes it there).
        // While a mode save runs, the held send waits for the save to settle (the mode-save path takes it there).
        if (!closed || !threadId || isStreaming || modeSaving) {
            return;
        }

        if (queue.items.length === 0) {
            return;
        }

        const held = releasableHeldSend(threadId, Boolean(error));

        if (held) {
            void sendNextPrompt(threadId, { explicit: held.explicit });
        }
    }, [editOpen, error, isStreaming, modeSaving, queue.items.length, queue.paused, sendNextPrompt, threadId]);

    // A held send whose message has become the head (a move ahead of it moved it up again) goes once that message may send:
    // not while its own editor is open, since the edit's close releases it then.
    const headId = queue.items[0]?.id;
    const headEditingId = edit?.id;

    useEffect(() => {
        if (!threadId || headId === undefined || headEditingId === headId || isStreaming || modeSaving || queue.items.length === 0) {
            return;
        }

        const held = releasableHeldSend(threadId, Boolean(error));

        if (held) {
            void sendNextPrompt(threadId, { explicit: held.explicit });
        }
    }, [error, headEditingId, headId, isStreaming, modeSaving, queue.items.length, sendNextPrompt, threadId]);

    // A send held while the edit closed during a reply goes when that reply ends. An explicit one (Send next) goes even after
    // an error, resuming the queue as its own button does; an automatic one waits for the usual rules.
    // Kept with its thread: a reply that ends in another chat is not this one's end, and a switch to an idle chat with a held
    // send for it is the moment that send goes (the user came back to it).
    // No thread at first: a mount (a remount on returning to the chat) counts as switching into it, so a held send goes then.
    const streamRef = useRef<{ streaming: boolean; threadId: string | undefined }>({ streaming: isStreaming, threadId: undefined });

    useEffect(() => {
        const previous = streamRef.current;
        const ended = previous.threadId === threadId && previous.streaming && !isStreaming;
        const switchedIn = previous.threadId !== threadId;

        streamRef.current = { streaming: isStreaming, threadId };

        // A mode save in flight owns the held send: its settling takes it (the mode-save path above).
        if ((!ended && !switchedIn) || !threadId || isStreaming || modeSaving || queue.items.length === 0) {
            return;
        }

        const held = releasableHeldSend(threadId, Boolean(error));

        if (held) {
            void sendNextPrompt(threadId, { explicit: held.explicit });
        }
    }, [error, isStreaming, modeSaving, queue.items.length, queue.paused, sendNextPrompt, threadId]);

    const handleRemove = useCallback(
        (id: string) => {
            if (threadId) {
                void removePrompt(threadId, id);
            }
        },
        [removePrompt, threadId],
    );

    // The chip whose editor just closed: its Edit button takes focus once the queue has rendered, since the editor's own
    // control is gone by then. A saved change names the message's new id.
    const editFocus = useRef<string | undefined>(undefined);
    // The chip focus was last moved to. When it leaves the queue (a held send went), focus moves to the queue's first chip.
    const focusedChip = useRef<string | undefined>(undefined);

    useEffect(() => {
        const target = editFocus.current;

        if (target !== undefined) {
            editFocus.current = undefined;
            focusedChip.current = target;

            const chip = [...document.querySelectorAll<HTMLElement>("[data-queue-chip-id]")].find((element) => element.dataset.queueChipId === target);

            chip?.querySelector<HTMLButtonElement>("[data-edit]")?.focus();

            return;
        }

        const focused = focusedChip.current;

        if (focused !== undefined) {
            if (queue.items.every((item) => item.id !== focused)) {
                // The chip left the queue: focus that was on it moves to the first chip's Edit button, when one can take it.
                focusedChip.current = undefined;

                if (document.activeElement === null || document.activeElement === document.body) {
                    document.querySelector<HTMLButtonElement>("[data-queue-chip-id] [data-edit]:not(:disabled)")?.focus();
                }
            } else if (!document.activeElement?.closest("[data-queue-chip-id]")) {
                // Focus has moved on (the user clicked elsewhere): a later removal of this chip is no reason to take focus.
                focusedChip.current = undefined;
            }
        }
    });

    const handleEditStart = useCallback(
        (id: string, text: string) => {
            if (threadId) {
                useQueueEditStore.getState().start(threadId, id, text);
            }
        },
        [threadId],
    );

    const handleEditDraft = useCallback(
        (id: string, draft: string) => {
            if (threadId) {
                useQueueEditStore.getState().setDraft(threadId, id, draft);
            }
        },
        [threadId],
    );

    const handleEditStop = useCallback(
        (id: string) => {
            if (!threadId || useQueueEditStore.getState().editing[threadId]?.id !== id) {
                return;
            }

            editFocus.current = id;
            useQueueEditStore.getState().stop(threadId, id);
        },
        [threadId],
    );

    const handleEdit = useCallback(
        (id: string, text: string) => {
            if (!threadId) {
                return;
            }

            const store = usePromptQueueStore.getState();
            const index = (store.queues[threadId]?.items ?? []).findIndex((item) => item.id === id);

            store.edit(threadId, id, text);

            // A changed text is a new item in the same place, with a new id: focus follows it there.
            const after = usePromptQueueStore.getState().queues[threadId]?.items[index];

            if (after !== undefined) {
                editFocus.current = after.id;
                // The new id is the same message, edited: it is not an arrival for the queue's drain.
                seenRef.current.ids.add(after.id);
                // A hold for the old text now protects the saved message under its new id.
                useQueueEditStore.getState().renameHeldSend(threadId, id, after.id);
            }
        },
        [threadId],
    );

    // The chip a keyboard move was made from, so its button can take focus again once React has moved the chip.
    const pendingFocus = useRef<{ id: string; step: -1 | 1 } | null>(null);
    // The announcement names the thread it was made in, so a move in one chat is never read out in another.
    const [announcement, setAnnouncement] = useState<{ text: string; threadId: string | undefined }>({ text: "", threadId: undefined });

    // The frame that would set the next announcement, so emptying the queue can cancel it.
    const announceFrame = useRef<number | null>(null);

    // Cleared first and set on the next frame, so the same text said twice in a row is announced again.
    const announce = useCallback((text: string, announcedThreadId: string | undefined) => {
        setAnnouncement({ text: "", threadId: announcedThreadId });

        if (announceFrame.current !== null) {
            globalThis.cancelAnimationFrame(announceFrame.current);
        }

        announceFrame.current = globalThis.requestAnimationFrame(() => {
            announceFrame.current = null;
            setAnnouncement({ text, threadId: announcedThreadId });
        });
    }, []);

    // A move is read out once: it is dropped when the queue empties, when another thread is shown, and when the
    // queue refills, so a later queue (or returning to this thread) does not repeat it.
    const queueIsEmpty = queue.items.length === 0;

    useEffect(() => {
        if (announceFrame.current !== null) {
            globalThis.cancelAnimationFrame(announceFrame.current);
            announceFrame.current = null;
        }

        setAnnouncement({ text: "", threadId: undefined });
    }, [queueIsEmpty, threadId]);

    useEffect(() => {
        const focus = pendingFocus.current;

        if (!focus) {
            return;
        }

        pendingFocus.current = null;

        const chip = [...document.querySelectorAll<HTMLElement>("[data-queue-chip-id]")].find((element) => element.dataset.queueChipId === focus.id);
        // The button in the direction of the move, or the other one when the chip reached an end.
        const sameWay = chip?.querySelector<HTMLButtonElement>(focus.step < 0 ? "[data-move-up]" : "[data-move-down]");
        const otherWay = chip?.querySelector<HTMLButtonElement>(focus.step < 0 ? "[data-move-down]" : "[data-move-up]");

        if (sameWay && !sameWay.disabled) {
            sameWay.focus();
        } else if (otherWay && !otherWay.disabled) {
            otherWay.focus();
        }
    });

    const handleMove = useCallback(
        (id: string, step: -1 | 1) => {
            if (!threadId) {
                return;
            }

            const from = (usePromptQueueStore.getState().queues[threadId]?.items ?? []).findIndex((item) => item.id === id);

            usePromptQueueStore.getState().move(threadId, id, { step });

            const to = (usePromptQueueStore.getState().queues[threadId]?.items ?? []).findIndex((item) => item.id === id);

            if (from !== -1 && to !== from) {
                announce(t`Moved to position ${to + 1}`, threadId);
            }

            if (document.activeElement?.closest("[data-queue-chip-id]")) {
                pendingFocus.current = { id, step };
            }
        },
        [announce, t, threadId],
    );

    // A small distance before a drag starts, so a click on a chip's buttons stays a click.
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

    const handleDragEnd = useCallback(
        ({ active, over }: DragEndEvent) => {
            const items = usePromptQueueStore.getState().queues[threadId ?? ""]?.items ?? [];
            const toIndex = over ? items.findIndex((item) => item.id === over.id) : -1;

            if (threadId && toIndex !== -1) {
                const from = items.findIndex((item) => item.id === active.id);

                usePromptQueueStore.getState().move(threadId, String(active.id), toIndex);

                // The store may refuse the move (a steer on the way): announce the position it actually has.
                const to = (usePromptQueueStore.getState().queues[threadId]?.items ?? []).findIndex((item) => item.id === active.id);

                if (from !== -1 && to !== from) {
                    announce(t`Moved to position ${to + 1}`, threadId);
                }
            }
        },
        [announce, t, threadId],
    );

    const handleSendNext = useCallback(() => {
        if (!threadId) {
            return;
        }

        usePromptQueueStore.getState().setPaused(threadId, false);
        // Send next is the owner's own resume: it lifts the failed-save mark along with the pause, and replaces any hold.
        useQueueEditStore.getState().markFailedSave(threadId, false);
        // The hold is not taken here: a send that goes fulfils it, and a refused send leaves it for the next release.
        void sendNextPrompt(threadId, { explicit: true });
    }, [sendNextPrompt, threadId]);

    if (queue.items.length === 0) {
        return null;
    }

    const count = queue.items.length;
    const steerCount = queue.items.filter((item) => item.steer).length;
    const willAutoSend = isStreaming && !queue.paused;
    let statusText: ReactNode = willAutoSend ? t`${count} queued — sends when the current reply finishes` : t`${count} queued`;

    if (steerCount === count && isStreaming) {
        statusText = <Plural one="# steering — the reply reads it at its next step" other="# steering — the reply reads them at its next step" value={count} />;
    }

    // "Send next" is disabled while the head's text is open: say why, and that the send follows the edit. A paused queue
    // sends nothing on a close, so it makes no such promise.
    // The promise holds only for a hold that names the message being edited (the release rule's own match).
    if (headEditing && !queue.paused && !isStreaming && heldSend !== undefined && (heldSend.id === undefined || heldSend.id === edit?.id)) {
        statusText = t`${count} queued — sends when the edit closes`;
    }

    // "Send next" is disabled while the permission mode saves: say why, and that the queue moves on once it has.
    if (modeSaving && !isStreaming && !queue.paused) {
        statusText = t`${count} queued — waiting for the permission mode to save`;
    }

    return (
        <div className="mx-2 mt-2 flex flex-wrap items-center gap-1.5">
            <span aria-live="polite" className="text-muted-foreground flex items-center gap-1 text-xs" role="status">
                <ListOrderedIcon aria-hidden="true" className="size-3.5" />
                {statusText}
            </span>
            <span aria-live="polite" className="sr-only" role="status">
                {announcement.threadId === threadId ? announcement.text : ""}
            </span>
            <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} sensors={sensors}>
                <SortableContext items={queue.items.map((prompt) => prompt.id)} strategy={rectSortingStrategy}>
                    <ol aria-label={t`Queued messages`} className="flex min-w-0 flex-wrap gap-1.5">
                        {queue.items.map((prompt, index) => (
                            <QueueChip
                                blockedDown={queue.items[index + 1]?.steer !== undefined}
                                blockedUp={index > 0 && queue.items[index - 1]?.steer !== undefined}
                                count={count}
                                editDraft={edit?.id === prompt.id ? edit.draft : undefined}
                                editLocked={edit !== undefined && edit.id !== prompt.id}
                                key={prompt.id}
                                onEdit={handleEdit}
                                onEditDraft={handleEditDraft}
                                onEditStart={handleEditStart}
                                onEditStop={handleEditStop}
                                onMove={handleMove}
                                onRemove={handleRemove}
                                position={index + 1}
                                prompt={prompt}
                            />
                        ))}
                    </ol>
                </SortableContext>
            </DndContext>
            {!isStreaming && (
                <Button
                    className="h-6 gap-1 px-2 text-xs"
                    disabled={modeSaving || headEditing}
                    onClick={handleSendNext}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    <SendIcon aria-hidden="true" className="size-3" />
                    {t`Send next`}
                </Button>
            )}
        </div>
    );
};

export default ComposerPromptQueue;
