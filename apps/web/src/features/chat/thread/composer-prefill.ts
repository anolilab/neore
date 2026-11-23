/**
 * Puts text into one thread's composer from UI that is not part of it (a header chip). It never sends: the person reads,
 * edits and sends it. Each thread keeps its own queue, so a request for one thread never displaces another's, and a queue is
 * taken only once that thread's composer is live and its stored draft is back (`useBoundDraftStore`): text that arrived first
 * would keep the saved draft out. A request still waiting when its composer goes away is dropped.
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useBoundDraftStore } from "@/features/chat/split/composer-drafts";

interface PrefillState {
    /** Thread ids with a composer that takes prefills mounted; a control that fills one shows only for these. */
    composers: ReadonlySet<string>;
    /** Texts waiting for their thread's composer, oldest first. Replaced on each change, never mutated. */
    pending: ReadonlyMap<string, ReadonlyArray<string>>;
}

const usePrefillStore = create<PrefillState>()(() => {
    return { composers: new Set<string>(), pending: new Map<string, ReadonlyArray<string>>() };
});

export const prefillComposer = (threadId: string, text: string): void => {
    const { pending } = usePrefillStore.getState();
    const queued = pending.get(threadId) ?? [];

    // A second click before the composer took the first adds nothing new.
    if (queued.includes(text)) {
        return;
    }

    usePrefillStore.setState({ pending: new Map(pending).set(threadId, [...queued, text]) });
};

/** Whether `threadId` has a composer on the page that takes prefilled text (not a worker's or a comparison's own). */
export const useComposerTakesPrefill = (threadId: string | undefined): boolean =>
    usePrefillStore((state: PrefillState) => threadId !== undefined && state.composers.has(threadId));

const take = (threadId: string): ReadonlyArray<string> => {
    const { pending } = usePrefillStore.getState();
    const queued = pending.get(threadId);

    if (!queued) {
        return [];
    }

    const next = new Map(pending);

    next.delete(threadId);
    usePrefillStore.setState({ pending: next });

    return queued;
};

const setComposer = (threadId: string, mounted: boolean): void => {
    const next = new Set(usePrefillStore.getState().composers);

    if (mounted) {
        next.add(threadId);
    } else {
        next.delete(threadId);
    }

    usePrefillStore.setState({ composers: next });
};

/** The thread composer subscribes with this; `apply` receives each text meant for `threadId`, once its draft is settled. */
export const useComposerPrefill = (threadId: string | undefined, apply: (text: string) => void): void => {
    // The latest `apply`, so a new callback does not resubscribe: the cleanup below drops what is waiting.
    const applyRef = useRef(apply);

    useEffect(() => {
        applyRef.current = apply;
    });

    useEffect(() => {
        if (threadId === undefined) {
            return undefined;
        }

        setComposer(threadId, true);

        const drain = () => {
            if (!useBoundDraftStore.getState().owners.has(threadId) || !usePrefillStore.getState().pending.has(threadId)) {
                return;
            }

            for (const text of take(threadId)) {
                applyRef.current(text);
            }
        };

        drain();

        const stopPending = usePrefillStore.subscribe(drain);
        const stopBound = useBoundDraftStore.subscribe(drain);

        return () => {
            stopPending();
            stopBound();
            setComposer(threadId, false);
            // Left before its draft settled: the request was for this visit, not for whenever the chat next opens.
            take(threadId);
        };
    }, [threadId]);
};

/** For tests: forgets every queued text and mounted composer. */
export const resetComposerPrefillForTests = (): void => {
    usePrefillStore.setState({ composers: new Set<string>(), pending: new Map<string, ReadonlyArray<string>>() });
};
