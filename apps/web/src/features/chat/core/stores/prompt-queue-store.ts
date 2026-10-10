"use client";

/**
 * Prompt queue store — per-thread queues of messages submitted while a turn was
 * streaming.
 *
 * Mirrored per thread into sessionStorage so a reload does not lose them, TEXT
 * ONLY: queued attachments hold `File` objects, which storage cannot keep, so a
 * restored prompt carries a count of what it lost instead. A restored queue is
 * always paused — it waits for "Send next" rather than auto-sending prompts the
 * user may no longer remember queuing. Storage can be unavailable (private
 * windows, blocked site data), so every access is guarded and failure just
 * means the queue is in-memory only.
 *
 * The transition rules live in `core/utils/prompt-queue.ts`.
 */

import { create } from "zustand";

import type { PromptQueueState, QueuedPrompt } from "@/features/chat/core/utils/prompt-queue";
import {
    dequeuePrompt,
    EMPTY_PROMPT_QUEUE,
    enqueuePrompt,
    removeQueuedPrompt,
    restorePromptQueue,
    serializePromptQueue,
} from "@/features/chat/core/utils/prompt-queue";

import type { PendingAttachment } from "./chat-ui-store";

export type QueuedChatPrompt = QueuedPrompt<PendingAttachment>;
type ThreadQueue = PromptQueueState<PendingAttachment>;

interface PromptQueueStore {
    enqueue: (threadId: string, prompt: Omit<QueuedChatPrompt, "id">) => void;
    /** Loads a thread's queue from sessionStorage once per page load, if memory has none. */
    hydrate: (threadId: string) => void;
    queues: Record<string, ThreadQueue>;
    remove: (threadId: string, id: string) => void;
    setPaused: (threadId: string, paused: boolean) => void;
    /** Removes and returns the oldest queued prompt. */
    shift: (threadId: string) => QueuedChatPrompt | undefined;
}

const STORAGE_KEY_PREFIX = "neore:prompt-queue:";

const generatePromptId = () => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const readStoredQueue = (threadId: string): string | null => {
    try {
        return globalThis.sessionStorage?.getItem(STORAGE_KEY_PREFIX + threadId) ?? null;
    } catch {
        return null;
    }
};

const writeStoredQueue = (threadId: string, queue: ThreadQueue): void => {
    try {
        const serialized = serializePromptQueue(queue);

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
        enqueue: (threadId, prompt) => update(threadId, (queue) => enqueuePrompt(queue, { ...prompt, id: generatePromptId() })),
        hydrate: (threadId) => {
            if (hydratedThreadIds.has(threadId)) {
                return;
            }

            hydratedThreadIds.add(threadId);

            if (get().queues[threadId]?.items.length) {
                return;
            }

            const restored = restorePromptQueue(readStoredQueue(threadId));

            if (restored) {
                set((state) => {
                    return { queues: { ...state.queues, [threadId]: restored } };
                });
            }
        },
        queues: {},
        remove: (threadId, id) => update(threadId, (queue) => removeQueuedPrompt(queue, id)),
        setPaused: (threadId, paused) => update(threadId, (queue) => (queue.paused === paused ? queue : { ...queue, paused })),
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
