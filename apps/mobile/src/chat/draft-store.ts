import { useSyncExternalStore } from "react";

/**
 * The composer's text, outside React state. Only the composer subscribes, so a keystroke re-renders the composer and
 * not the chat screen around it (its message list included). The screen reads and writes it on send and on a failed
 * send: `get` is always the composer as the last write left it, not as some render saw it.
 */
export interface DraftStore {
    get: () => string;
    set: (update: string | ((current: string) => string)) => void;
    subscribe: (listener: () => void) => () => void;
}

export const createDraftStore = (initial = ""): DraftStore => {
    let value = initial;
    const listeners = new Set<() => void>();

    return {
        get: () => value,
        set: (update) => {
            const next = typeof update === "function" ? update(value) : update;

            if (next === value) {
                return;
            }

            value = next;

            for (const listener of listeners) {
                listener();
            }
        },
        subscribe: (listener) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
};

/** The draft's text, for the one component that shows it. */
export const useDraft = (store: DraftStore): string => useSyncExternalStore(store.subscribe, store.get, store.get);
