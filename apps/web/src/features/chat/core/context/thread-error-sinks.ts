/**
 * A media kick-off fails after the send has navigated, so the provider that
 * started it may be gone (a first message moves from `/chat` to
 * `/chat/$threadId`, which mounts a new one). Each mounted provider registers
 * its error handler for its thread; a failure with no handler waits here for
 * the provider that mounts next.
 */
const threadErrorSinks = new Map<string, (error: unknown) => void>();
const undeliveredThreadErrors = new Map<string, { at: number; error: unknown }>();
const UNDELIVERED_ERROR_TTL_MS = 30_000;

export const reportThreadError = (threadId: string, error: unknown) => {
    const sink = threadErrorSinks.get(threadId);

    if (sink) {
        sink(error);
    } else {
        undeliveredThreadErrors.set(threadId, { at: Date.now(), error });
    }
};

/** Takes the failure that waited for this thread's provider; `undefined` when none did or it is older than the TTL. */
export const takeUndeliveredThreadError = (threadId: string): { error: unknown } | undefined => {
    const undelivered = undeliveredThreadErrors.get(threadId);

    undeliveredThreadErrors.delete(threadId);

    return undelivered && Date.now() - undelivered.at < UNDELIVERED_ERROR_TTL_MS ? { error: undelivered.error } : undefined;
};

/** Registers `sink` as the thread's error handler; the returned cleanup removes it only if it is still the registered one. */
export const registerThreadErrorSink = (threadId: string, sink: (error: unknown) => void): (() => void) => {
    threadErrorSinks.set(threadId, sink);

    return () => {
        if (threadErrorSinks.get(threadId) === sink) {
            threadErrorSinks.delete(threadId);
        }
    };
};
