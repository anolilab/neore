/**
 * A native object made on first use instead of when its screen mounts: the recorder is only needed once someone holds
 * the microphone button, and most visits to a chat never do.
 */
export interface LazyResource<T> {
    /** The object, made now if there is none yet or the last one was released. */
    get: () => T;
    /** The object made last, released or not, without making one: a stop after leaving still reaches its recorder. */
    peek: () => T | undefined;
    /** Releases the object, if one was made. The next `get` makes a new one (a remount reuses the same holder). */
    release: () => void;
}

export const createLazyResource = <T>(create: () => T, dispose: (value: T) => void): LazyResource<T> => {
    let current: T | undefined;
    let isReleased = true;

    return {
        get: () => {
            if (current === undefined || isReleased) {
                current = create();
                isReleased = false;
            }

            return current;
        },
        peek: () => current,
        release: () => {
            if (current === undefined || isReleased) {
                return;
            }

            isReleased = true;
            dispose(current);
        },
    };
};
