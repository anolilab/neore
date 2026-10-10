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
 */

export interface QueuedPrompt<A> {
    attachments: A[];
    /** Attachments that did not survive a reload (they are `File`s, which sessionStorage cannot hold). */
    droppedAttachments?: number;
    id: string;
    text: string;
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
    items: { droppedAttachments: number; id: string; text: string }[];
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
            return { droppedAttachments: item.attachments.length + (item.droppedAttachments ?? 0), id: item.id, text: item.text };
        });

    return items.length > 0 ? JSON.stringify({ items } satisfies StoredPromptQueue) : undefined;
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
        const { droppedAttachments, id, text } = (candidate ?? {}) as { droppedAttachments?: unknown; id?: unknown; text?: unknown };

        if (typeof id !== "string" || typeof text !== "string" || !text.trim()) {
            continue;
        }

        const dropped = typeof droppedAttachments === "number" && droppedAttachments > 0 ? Math.floor(droppedAttachments) : 0;

        items.push(dropped > 0 ? { attachments: [], droppedAttachments: dropped, id, text } : { attachments: [], id, text });
    }

    return items.length > 0 ? { items, paused: true } : undefined;
};
