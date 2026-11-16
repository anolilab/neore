import type { AuthStatus } from "../auth/auth-state";

/**
 * Whether the splash may go. A signed-out launch shows the sign-in screen at once. A signed-in one on the chat list
 * waits until the list has read its saved rows, so a returning person never sees it empty; any other first screen
 * goes at once. The root layout's time cap hides it whatever this says.
 */
export const canHideSplash = ({ isListReady, isOnList, status }: { isListReady: boolean; isOnList: boolean; status: AuthStatus }): boolean => {
    if (status === "loading") {
        return false;
    }

    return status === "signed-out" || !isOnList || isListReady;
};

/** Set once by the chat list when its saved rows are read (or known to be none); the splash gate listens. */
const createListReadySignal = () => {
    const state = { isReady: false };
    const listeners = new Set<() => void>();

    return {
        isReady: (): boolean => state.isReady,
        /** Only the first call matters. */
        mark: (): void => {
            if (state.isReady) {
                return;
            }

            state.isReady = true;

            for (const listener of listeners) {
                listener();
            }
        },
        subscribe: (listener: () => void): () => void => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
};

export const listReady = createListReadySignal();
