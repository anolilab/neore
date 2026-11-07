"use client";

/**
 * Prompt queue store — per-thread queues of messages submitted while a turn was
 * streaming.
 *
 * Mirrored per thread into sessionStorage so a reload does not lose them. A
 * queued attachment is kept by its uploaded file id, never its bytes, and comes
 * back as an uploaded attachment with an empty stand-in `File`, which the
 * composer neither previews nor edits; one without an id is counted as lost
 * instead. The queue lives in the tab's
 * sessionStorage, not shared by every tab on the thread: each tab drains its own
 * queue, so a shared one would send its head once per open tab. A duplicated tab
 * starts with a copy, which is restored paused like any other. A restored queue is
 * always paused — it waits for "Send next" rather than auto-sending prompts the
 * user may no longer remember queuing. Storage can be unavailable (private
 * windows, blocked site data), so every access is guarded and failure just
 * means the queue is in-memory only.
 *
 * The transition rules live in `core/utils/prompt-queue.ts`.
 */

import { create } from "zustand";

import type { PromptQueueState, QueuedPrompt, StoredAttachment } from "@/features/chat/core/utils/prompt-queue";
import {
    dequeuePrompt,
    editQueuedPrompt,
    EMPTY_PROMPT_QUEUE,
    enqueuePrompt,
    moveQueuedPrompt,
    prependPrompt,
    removeQueuedPrompt,
    restorePromptQueue,
    serializePromptQueue,
    settleQueuedSteer,
    stepQueuedPrompt,
} from "@/features/chat/core/utils/prompt-queue";

import type { PendingAttachment } from "./chat-ui-store";

export type QueuedChatPrompt = QueuedPrompt<PendingAttachment>;
type ThreadQueue = PromptQueueState<PendingAttachment>;

interface PromptQueueStore {
    /** Replaces a queued message's text in place; a steered message is left as it is. */
    edit: (threadId: string, id: string, text: string) => void;
    /** Queues a message. A caller that retries a send it already made passes that send's id, so the backend knows it is the same message. */
    enqueue: (threadId: string, prompt: Omit<QueuedChatPrompt, "id"> & { id?: string }) => void;
    /** Puts the prompt first and lifts a pause, so it is the next one sent. */
    enqueueNext: (threadId: string, prompt: Omit<QueuedChatPrompt, "id"> & { id?: string }) => void;
    /** Loads a thread's queue from sessionStorage once per page load, if memory has none. */
    hydrate: (threadId: string) => void;
    /** Moves a queued message to `toIndex`, or one place up (`-1`) or down (`1`). */
    move: (threadId: string, id: string, to: number | { step: -1 | 1 }) => void;
    queues: Record<string, ThreadQueue>;
    remove: (threadId: string, id: string) => void;
    setPaused: (threadId: string, paused: boolean) => void;
    /** `steerRun` answered: keeps the steer (`accepted`) or makes it an ordinary queued message (`refused`). */
    settleSteer: (threadId: string, steerId: string, outcome: "accepted" | "refused") => void;
    /** Removes and returns the oldest queued prompt. */
    shift: (threadId: string) => QueuedChatPrompt | undefined;
}

const STORAGE_KEY_PREFIX = "neore:prompt-queue:";

const generatePromptId = () => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/** Keeps an attachment by its uploaded file id; one still uploading or failed has none, so it is not kept. */
export const toStoredAttachment = (attachment: PendingAttachment): StoredAttachment | undefined =>
    attachment.status === "complete" && attachment.fileId
        ? { fileId: attachment.fileId, kind: attachment.type, mediaType: attachment.file.type, name: attachment.name }
        : undefined;

/** An uploaded attachment again: the send reads only its file id, so its `File` is an empty stand-in. */
export const fromStoredAttachment = (stored: StoredAttachment): PendingAttachment => {
    return {
        file: new File([], stored.name, { type: stored.mediaType }),
        fileId: stored.fileId,
        id: `restored-${stored.fileId}`,
        name: stored.name,
        status: "complete",
        type: stored.kind,
    };
};

const readStoredQueue = (threadId: string): string | null => {
    try {
        return globalThis.sessionStorage?.getItem(STORAGE_KEY_PREFIX + threadId) ?? null;
    } catch {
        return null;
    }
};

const writeStoredQueue = (threadId: string, queue: ThreadQueue): void => {
    try {
        const serialized = serializePromptQueue(queue, toStoredAttachment);

        if (serialized) {
            globalThis.sessionStorage?.setItem(STORAGE_KEY_PREFIX + threadId, serialized);
        } else {
            globalThis.sessionStorage?.removeItem(STORAGE_KEY_PREFIX + threadId);
        }
    } catch {
        // Quota or blocked storage: the queue still works for this page load.
    }
};

/** Threads already checked against storage this page load, so a drained queue is not resurrected. */
const hydratedThreadIds = new Set<string>();

export const usePromptQueueStore = create<PromptQueueStore>()((set, get) => {
    const update = (threadId: string, next: (queue: ThreadQueue) => ThreadQueue) => {
        // A write that beats the composer's hydrate effect must not clobber the stored queue.
        get().hydrate(threadId);

        const current = get().queues[threadId] ?? EMPTY_PROMPT_QUEUE;
        const updated = next(current);

        if (updated === current) {
            return;
        }

        set((state) => {
            return { queues: { ...state.queues, [threadId]: updated } };
        });
        writeStoredQueue(threadId, updated);
    };

    return {
        edit: (threadId, id, text) => update(threadId, (queue) => editQueuedPrompt(queue, id, text, generatePromptId())),
        enqueue: (threadId, prompt) => update(threadId, (queue) => enqueuePrompt(queue, { ...prompt, id: prompt.id ?? generatePromptId() })),
        enqueueNext: (threadId, prompt) =>
            update(threadId, (queue) => {
                return { ...prependPrompt(queue, { ...prompt, id: prompt.id ?? generatePromptId() }), paused: false };
            }),
        hydrate: (threadId) => {
            if (hydratedThreadIds.has(threadId)) {
                return;
            }

            hydratedThreadIds.add(threadId);

            if (get().queues[threadId]?.items.length) {
                return;
            }

            const restored = restorePromptQueue(readStoredQueue(threadId), fromStoredAttachment);

            if (restored) {
                set((state) => {
                    return { queues: { ...state.queues, [threadId]: restored } };
                });
            }
        },
        move: (threadId, id, to) =>
            update(threadId, (queue) => (typeof to === "number" ? moveQueuedPrompt(queue, id, to) : stepQueuedPrompt(queue, id, to.step))),
        queues: {},
        remove: (threadId, id) => update(threadId, (queue) => removeQueuedPrompt(queue, id)),
        setPaused: (threadId, paused) => update(threadId, (queue) => (queue.paused === paused ? queue : { ...queue, paused })),
        settleSteer: (threadId, steerId, outcome) => update(threadId, (queue) => settleQueuedSteer(queue, steerId, outcome)),
        shift: (threadId) => {
            const { next, state } = dequeuePrompt(get().queues[threadId] ?? EMPTY_PROMPT_QUEUE);

            if (next) {
                update(threadId, () => state);
            }

            return next;
        },
    };
});

/** Selector for one thread's queue; returns a stable empty queue when there is none. */
export const selectThreadQueue =
    (threadId: string | undefined) =>
    (state: PromptQueueStore): ThreadQueue =>
        (threadId ? state.queues[threadId] : undefined) ?? EMPTY_PROMPT_QUEUE;
