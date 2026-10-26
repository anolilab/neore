/**
 * Registers `waitUntil` NOW for work whose promise does not exist yet, and returns the
 * function that hands it over once it does.
 *
 * A streamed reply records its usage after the relay drains, which can be after the
 * Response has ended (a client cancel). The runtime may cancel work that is not
 * registered with `waitUntil` by then, and registering inside the relay is too late:
 * the awaits that precede it (pricing read, provider usage) are exactly what gets
 * cancelled. Call this before the Response is returned, and call the returned
 * function exactly once from the relay's `finally`. The work's own failures are
 * swallowed here; pass promises that already settle (`Promise.allSettled`).
 */
export const deferWaitUntil = (executionContext: { waitUntil: (promise: Promise<unknown>) => void }): ((work: Promise<unknown>) => void) => {
    let hand!: (work: Promise<unknown>) => void;

    executionContext.waitUntil(
        new Promise<void>((resolve) => {
            hand = (work) => {
                resolve(work.then(
                    () => undefined,
                    () => undefined,
                ));
            };
        }),
    );

    return hand;
};
