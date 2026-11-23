"use client";

/**
 * Puts a prompt into one thread's composer for the person to read and send. Never sends: the composer only takes the
 * text (after what is already typed) and gets focus. Requests wait per thread, in order, for the composer of THEIR
 * thread: one made while that thread is not open is taken when it opens, a second one does not replace the first, and
 * another thread's composer leaves them alone.
 */

import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

interface PrefillState {
    /** Prompts not yet taken, per thread, oldest first. */
    pending: Readonly<Record<string, ReadonlyArray<string>>>;
}

const usePrefillStore = create<PrefillState>()(() => {
    return { pending: {} };
});

export const prefillComposer = (threadId: string, text: string): void => {
    usePrefillStore.setState((state) => {
        return { pending: { ...state.pending, [threadId]: [...(state.pending[threadId] ?? []), text] } };
    });
};

/** Removes and returns every prompt waiting for `threadId`. */
const takeFor = (threadId: string): ReadonlyArray<string> => {
    const waiting = usePrefillStore.getState().pending[threadId];

    if (waiting === undefined) {
        return [];
    }

    usePrefillStore.setState((state) => {
        return { pending: Object.fromEntries(Object.entries(state.pending).filter(([key]) => key !== threadId)) };
    });

    return waiting;
};

/** The composer of `threadId` takes each prompt meant for it, in order; `undefined` (a new chat) takes none. */
export const useComposerPrefill = (threadId: string | undefined, onPrefill: (text: string) => void): void => {
    const handle = useEffectEvent(onPrefill);

    useEffect(() => {
        if (threadId === undefined) {
            return undefined;
        }

        const drain = (): void => {
            for (const text of takeFor(threadId)) {
                handle(text);
            }
        };

        drain();

        return usePrefillStore.subscribe((state) => {
            if (state.pending[threadId] !== undefined) {
                drain();
            }
        });
    }, [threadId]);
};
