/**
 * Runs the calls made for a stream of picks one at a time, in the order made, and says whether a pick
 * is still the newest when its call settles. The server applies calls in the order they arrive, so the
 * last pick must also be the last call; a slow answer to an earlier pick must not be applied over it.
 */
export const createLatestPickQueue = () => {
    let tail: Promise<unknown> = Promise.resolve();
    let latest = 0;

    return {
        /** Starts `call` once every earlier call has settled (a failed one does not block the next). */
        run: <T>(call: () => Promise<T>): { isLatest: () => boolean; result: Promise<T> } => {
            latest += 1;

            const pick = latest;
            const result = tail.then(call);

            tail = result.catch(() => {});

            return { isLatest: () => pick === latest, result };
        },
    };
};
