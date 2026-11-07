/**
 * Applies the answer of the newest read only. Reads of the shell's status can resolve out of order, and an older
 * snapshot (a failure) must not overwrite a newer one (the server connected).
 */
export const createLatestRead = <T>(read: () => Promise<T>, apply: (value: T) => void): (() => void) => {
    let newest = 0;

    return () => {
        newest += 1;

        const mine = newest;

        void read().then((value) => {
            if (mine === newest) {
                apply(value);
            }

            return undefined;
        });
    };
};
