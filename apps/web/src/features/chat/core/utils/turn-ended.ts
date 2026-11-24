/**
 * The end of a thread's turn as the chat's own stream state saw it (`ChatProvider`: the thread stopped streaming). Kept per
 * thread, outside any component, so a control elsewhere on the page hears it even while its own read of the thread has not
 * answered: a turn that starts and ends before that read would otherwise go unseen.
 */
const listeners = new Map<string, Set<() => void>>();

export const markTurnEnded = (threadId: string): void => {
    for (const listener of listeners.get(threadId) ?? []) {
        listener();
    }
};

/** Hears each end of a turn in `threadId` from now on; returns the unsubscribe. */
export const subscribeTurnEnded = (threadId: string, listener: () => void): (() => void) => {
    const forThread = listeners.get(threadId) ?? new Set<() => void>();

    forThread.add(listener);
    listeners.set(threadId, forThread);

    return () => {
        forThread.delete(listener);

        if (forThread.size === 0 && listeners.get(threadId) === forThread) {
            listeners.delete(threadId);
        }
    };
};
