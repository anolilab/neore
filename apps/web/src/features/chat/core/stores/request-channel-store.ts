"use client";

/**
 * One-shot request channels between components that are not parent and child —
 * "restore this message to the composer", "scroll the thread to this message".
 *
 * A request is held in a zustand store until a consumer TAKES it, so it is
 * typed end to end and a request made while no consumer is mounted is delivered
 * when one mounts, rather than dropped as a window event would be. Each request
 * is consumed once: with several subscribers, the first takes it.
 */

import type { StoreApi, UseBoundStore } from "zustand";
import { create } from "zustand";

interface RequestChannelState<T> {
    /** Wrapped so requesting an identical payload twice still notifies. */
    pending: { payload: T } | null;
    request: (payload: T) => void;
    /** Removes and returns the pending request, if any. */
    take: () => T | undefined;
}

export interface RequestChannel<T> {
    /** Delivers any pending request now, then every later one; returns the unsubscribe function. */
    consume: (handler: (payload: T) => void) => () => void;
    request: (payload: T) => void;
    store: UseBoundStore<StoreApi<RequestChannelState<T>>>;
}

export const createRequestChannel = <T>(): RequestChannel<T> => {
    const store = create<RequestChannelState<T>>()((set, get) => {
        return {
            pending: null,
            request: (payload) => set({ pending: { payload } }),
            take: () => {
                const { pending } = get();

                if (!pending) {
                    return undefined;
                }

                set({ pending: null });

                return pending.payload;
            },
        };
    });

    const consume = (handler: (payload: T) => void): (() => void) => {
        const drain = () => {
            const { pending, take } = store.getState();

            if (pending) {
                handler(take() as T);
            }
        };

        drain();

        return store.subscribe((state) => {
            if (state.pending) {
                drain();
            }
        });
    };

    return {
        consume,
        request: (payload) => store.getState().request(payload),
        store,
    };
};
