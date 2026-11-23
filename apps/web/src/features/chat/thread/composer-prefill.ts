"use client";

/**
 * Puts a prompt into one thread's composer for the person to read and send. Never sends: the composer only takes the
 * text (after what is already typed) and gets focus. Requests wait per thread, in order, for the composer of THEIR
 * thread: one made while that thread is not open is taken when it opens, a second one does not replace the first, the
 * same one twice is queued once, and another thread's composer leaves them alone. The shared thread composer (a comparison
 * parent's too) takes them only once its stored draft is back (`useBoundDraftStore`), and not while an untouched prefilled
 * message of THAT thread is sending: its saved draft comes back when the send ends, and text that arrived first would keep it
 * out. Another thread's send holds nothing. Held
 * prompts then go in after the restored draft, in order.
 */

import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import type { ThreadLoad } from "@/features/chat/core/context/thread-load";
import { useBoundDraftStore } from "@/features/chat/split/composer-drafts";

interface PrefillState {
    /** Thread ids with a composer that takes prompts mounted; a control that fills one shows only for these. */
    composers: ReadonlySet<string>;
    /** Prompts not yet taken, per thread, oldest first. */
    pending: Readonly<Record<string, ReadonlyArray<string>>>;
}

const usePrefillStore = create<PrefillState>()(() => {
    return { composers: new Set<string>(), pending: {} };
});

export const prefillComposer = (threadId: string, text: string): void => {
    usePrefillStore.setState((state) => {
        const queued = state.pending[threadId] ?? [];

        // A second click before the composer took the first adds nothing new.
        return queued.includes(text) ? state : { pending: { ...state.pending, [threadId]: [...queued, text] } };
    });
};

/**
 * The thread whose prompts a composer takes: none for the compact bar or a new chat, nor while its thread's read has failed.
 * Its stored draft cannot be bound then (`useStoredDrafts` waits for the thread), so a prompt it took could not go in; with
 * the composer unregistered, Catch up hides, and a prompt queued before goes in once the read recovers.
 */
export const prefillThreadOf = (threadId: string | undefined, compact: boolean, threadLoad: ThreadLoad | undefined): string | undefined =>
    !compact && threadId && threadLoad !== "failed" ? threadId : undefined;

/** Whether `threadId` has a composer on the page that takes prompts. */
export const useComposerTakesPrefill = (threadId: string | undefined): boolean =>
    usePrefillStore((state: PrefillState) => threadId !== undefined && state.composers.has(threadId));

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

const setComposer = (threadId: string, mounted: boolean): void => {
    usePrefillStore.setState((state) => {
        const next = new Set(state.composers);

        if (mounted) {
            next.add(threadId);
        } else {
            next.delete(threadId);
        }

        return { composers: next };
    });
};

/**
 * The composer of `threadId` takes each prompt meant for it, in order; `undefined` (a new chat) takes none. With
 * `awaitStoredDraft` (the shared composer, whose draft comes back from storage), it takes them only once that draft is,
 * and after the draft a prefilled message's send brings back.
 */
export const useComposerPrefill = (threadId: string | undefined, onPrefill: (text: string) => void, { awaitStoredDraft = false } = {}): void => {
    const handle = useEffectEvent(onPrefill);

    useEffect(() => {
        if (threadId === undefined) {
            return undefined;
        }

        setComposer(threadId, true);

        const drain = (): void => {
            if (usePrefillStore.getState().pending[threadId] === undefined) {
                return;
            }

            const bound = useBoundDraftStore.getState();

            if (awaitStoredDraft && (!bound.owners.has(threadId) || bound.restoreAfterSendFor === threadId)) {
                return;
            }

            for (const text of takeFor(threadId)) {
                handle(text);
            }
        };

        drain();

        const stopPending = usePrefillStore.subscribe(drain);
        const stopBound = awaitStoredDraft ? useBoundDraftStore.subscribe(drain) : undefined;

        return () => {
            stopPending();
            stopBound?.();
            setComposer(threadId, false);
        };
    }, [awaitStoredDraft, threadId]);
};

/** For tests: forgets every queued prompt and mounted composer. */
export const resetComposerPrefillForTests = (): void => {
    usePrefillStore.setState({ composers: new Set<string>(), pending: {} });
};
