/**
 * Sends a thread has begun whose reply is not streaming yet (`sendMessage`, from the composer, the queue or a guest note's
 * Send): the window before `isStreaming` turns on, where a second send would start a second run beside the first. Kept per
 * thread, outside any component, so every sender sees the others'.
 */
const starting = new Map<string, number>();

/**
 * A send's end, as its waiters need it: `refused` (its text went back to the composer to be fixed, banned words), told at
 * once even while another send there is still starting, so what waited behind it stays put rather than jump ahead; or the
 * end of the thread's last starting send.
 */
export interface SendEnded {
    refused: boolean;
    threadId: string;
}

const listeners = new Set<(ended: SendEnded) => void>();

const keyOf = (threadId: string | undefined): string => threadId ?? "";

export const markSendStarting = (threadId: string | undefined): void => {
    starting.set(keyOf(threadId), (starting.get(keyOf(threadId)) ?? 0) + 1);
};

export const clearSendStarting = (threadId: string | undefined, { refused = false }: { refused?: boolean } = {}): void => {
    const left = (starting.get(keyOf(threadId)) ?? 1) - 1;

    if (left > 0) {
        starting.set(keyOf(threadId), left);
    } else {
        starting.delete(keyOf(threadId));
    }

    // What waited for this send (a queued prompt) is told of a refusal at once, and otherwise once the thread has none starting.
    if (!refused && left > 0) {
        return;
    }

    for (const listener of listeners) {
        listener({ refused, threadId: keyOf(threadId) });
    }
};

/** Hears each refused send, and each time a thread's last starting send ends, with that thread; returns the unsubscribe. */
export const subscribeSendStarting = (listener: (ended: SendEnded) => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

export const isSendStarting = (threadId: string | undefined): boolean => starting.has(keyOf(threadId));
