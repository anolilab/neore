/**
 * Prompt queue — messages submitted while a turn is still streaming.
 *
 * Pure transitions; `prompt-queue-store.ts` holds one of these per thread.
 * The rules that matter:
 * - the queue drains ONE item per finished stream, in submission order;
 * - a manual stop pauses it (items stay visible, nothing auto-sends);
 * - a stream that ends in an error pauses it too, so one failure does not
 *   cascade into firing every queued prompt at a broken backend;
 * - a queue restored after a reload is always paused: nothing a user can no
 *   longer remember typing is sent without them asking for it.
 * - a STEERED prompt (`steer`) was handed to the running reply. It is
 *   withdrawn before it is sent (`chat_steering.withdrawSteer`): the reply may
 *   already have taken it, and then it is dropped instead.
 */

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";

export interface QueuedPrompt<A> {
    attachments: A[];
    /** Attachments that did not survive a reload (they are `File`s, which sessionStorage cannot hold). */
    droppedAttachments?: number;
    id: string;
    /** Reference images selected when the prompt was queued, so a later draft's picks do not replace them. */
    references?: ReferenceSelection[];
    /** Sent into the running reply (`chat/steering.ts`): its id on that run's stream. */
    steer?: QueuedSteer;
    text: string;
}

export interface QueuedSteer {
    id: string;
    streamId: string;
}

export interface PromptQueueState<A> {
    items: QueuedPrompt<A>[];
    paused: boolean;
}

export const EMPTY_PROMPT_QUEUE: PromptQueueState<never> = Object.freeze({ items: [], paused: false }) as PromptQueueState<never>;

export const enqueuePrompt = <A>(state: PromptQueueState<A>, item: QueuedPrompt<A>): PromptQueueState<A> => {
    return { ...state, items: [...state.items, item] };
};

export const removeQueuedPrompt = <A>(state: PromptQueueState<A>, id: string): PromptQueueState<A> => {
    const items = state.items.filter((item) => item.id !== id);

    // An emptied queue has nothing left to hold back.
    return { items, paused: items.length === 0 ? false : state.paused };
};

export const dequeuePrompt = <A>(state: PromptQueueState<A>): { next: QueuedPrompt<A> | undefined; state: PromptQueueState<A> } => {
    const [next, ...rest] = state.items;

    return { next, state: { ...state, items: rest } };
};

export type AutoSendDecision = "idle" | "pause" | "send";

/**
 * What to do when the streaming flag is observed. Only a streaming → idle
 * TRANSITION can send, so remounting the composer on a thread whose queue
 * outlived its stream (the user navigated away meanwhile) never fires anything
 * by surprise.
 */
export const decideAutoSend = ({
    hasError,
    isStreaming,
    paused,
    queueLength,
    wasStreaming,
}: {
    hasError: boolean;
    isStreaming: boolean;
    paused: boolean;
    queueLength: number;
    wasStreaming: boolean;
}): AutoSendDecision => {
    if (!wasStreaming || isStreaming || queueLength === 0 || paused) {
        return "idle";
    }

    return hasError ? "pause" : "send";
};

/** What a queue looks like in sessionStorage: text only. */
interface StoredPromptQueue {
    items: { droppedAttachments: number; id: string; steer?: QueuedSteer; text: string }[];
}

/**
 * Serialises a queue for sessionStorage, or `undefined` when there is nothing
 * worth keeping. Attachments are counted, not stored; a prompt that was ONLY
 * attachments has no text to restore and is left out.
 */
export const serializePromptQueue = <A>(state: PromptQueueState<A>): string | undefined => {
    const items = state.items
        .filter((item) => item.text.trim().length > 0)
        .map((item) => {
            return {
                droppedAttachments: item.attachments.length + (item.droppedAttachments ?? 0),
                id: item.id,
                ...(item.steer && { steer: item.steer }),
                text: item.text,
            };
        });

    return items.length > 0 ? JSON.stringify({ items } satisfies StoredPromptQueue) : undefined;
};

const readSteer = (value: unknown): QueuedSteer | undefined => {
    const { id, streamId } = (value ?? {}) as { id?: unknown; streamId?: unknown };

    return typeof id === "string" && typeof streamId === "string" ? { id, streamId } : undefined;
};

/**
 * The steered prompts the running reply has taken: every steer on `streamId`
 * whose id the stream reports delivered. Their chips go, and the message they
 * carried is in the thread.
 */
export const deliveredSteerItems = <A>(items: ReadonlyArray<QueuedPrompt<A>>, streamId: string, deliveredIds: ReadonlyArray<string>): string[] =>
    items.filter((item) => item.steer?.streamId === streamId && deliveredIds.includes(item.steer.id)).map((item) => item.id);

/** `chat_steering.withdrawSteer`'s answer. */
export type SteerWithdrawal = "delivered" | "unknown" | "withdrawn";

/**
 * The next prompt to send, shifted off the queue. A steered one is withdrawn
 * from its run first: `delivered` means the reply already has it, so it is
 * dropped and the next one is tried; `withdrawn` (never taken) and `unknown`
 * (its stream is gone) send it. A withdrawal that throws hands it back as
 * `requeue`, so it is neither lost nor sent twice.
 */
export const takeNextToSend = async <A>(
    shift: () => QueuedPrompt<A> | undefined,
    withdraw: (steer: QueuedSteer) => Promise<SteerWithdrawal>,
): Promise<{ kind: "requeue" | "send"; prompt: QueuedPrompt<A> } | undefined> => {
    for (let next = shift(); next; next = shift()) {
        if (!next.steer) {
            return { kind: "send", prompt: next };
        }

        let outcome: SteerWithdrawal;

        try {
            outcome = await withdraw(next.steer);
        } catch {
            return { kind: "requeue", prompt: next };
        }

        if (outcome !== "delivered") {
            return { kind: "send", prompt: next };
        }
    }

    return undefined;
};

/** Parses a stored queue. Always paused; anything malformed reads as "no queue". */
export const restorePromptQueue = (raw: string | null | undefined): PromptQueueState<never> | undefined => {
    if (!raw) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }

    const rawItems = (parsed as Partial<StoredPromptQueue> | null)?.items;

    if (!Array.isArray(rawItems)) {
        return undefined;
    }

    const items: QueuedPrompt<never>[] = [];

    for (const candidate of rawItems as unknown[]) {
        const { droppedAttachments, id, steer, text } = (candidate ?? {}) as { droppedAttachments?: unknown; id?: unknown; steer?: unknown; text?: unknown };

        if (typeof id !== "string" || typeof text !== "string" || !text.trim()) {
            continue;
        }

        const dropped = typeof droppedAttachments === "number" && droppedAttachments > 0 ? Math.floor(droppedAttachments) : 0;
        const restoredSteer = readSteer(steer);

        items.push({
            attachments: [],
            ...(dropped > 0 && { droppedAttachments: dropped }),
            id,
            ...(restoredSteer && { steer: restoredSteer }),
            text,
        });
    }

    return items.length > 0 ? { items, paused: true } : undefined;
};
