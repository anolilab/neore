/**
 * The end of a thread's turn as the chat's own stream state saw it (`ChatProvider`: the thread stopped streaming). Kept per
 * thread, outside any component, so a control elsewhere on the page hears it even while its own read of the thread has not
 * answered: a turn that starts and ends before that read would otherwise go unseen.
 */
const listeners = new Map<string, Set<() => void>>();

/**
 * How many turns of each thread ended on this page, kept after the listeners go: a control that was not mounted when a turn
 * ended (a split pane without focus) compares this with the count it last heard and knows it missed one.
 */
const generations = new Map<string, number>();

/** The count of turns of `threadId` that ended on this page so far; 0 when none did. */
export const turnEndedGeneration = (threadId: string): number => generations.get(threadId) ?? 0;

export const markTurnEnded = (threadId: string): void => {
    generations.set(threadId, turnEndedGeneration(threadId) + 1);

    const forThread = listeners.get(threadId) ?? [];

    for (const listener of forThread) {
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

/** Forgets every thread's count of ended turns, so one test's turns do not count as missed in the next. */
export const resetTurnEndedForTests = (): void => {
    generations.clear();
};
