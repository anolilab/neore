/**
 * Runs tasks one after another, in the order they were queued. A task that rejects
 * does not stop the queue; its caller still receives the rejection.
 */
export const createSerialQueue = () => {
    let tail: Promise<unknown> = Promise.resolve();

    return <T>(task: () => Promise<T>): Promise<T> => {
        const previous = tail;
        const run = (async () => {
            await previous;

            return task();
        })();

        tail = (async () => {
            try {
                await run;
            } catch {
                // The caller receives the rejection; the queue only waits for the task to end.
            }
        })();

        return run;
    };
};
