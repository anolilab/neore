import type { ReactNode } from "react";
import { createContext, use, useLayoutEffect, useState } from "react";
import type { StoreApi } from "zustand";
import { createStore, useStore } from "zustand";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";

import { usePullRequestCounts } from "../lib/use-develop";

interface PullRequestCounts {
    counts: ReadonlyMap<string, number>;
}

const PullRequestCountsContext = createContext<StoreApi<PullRequestCounts> | null>(null);

const NO_COUNTS = createStore<PullRequestCounts>(() => {
    return { counts: new Map() };
});

/**
 * Reads the linked pull request counts once for the threads a list shows; each row then reads its own from here. The counts sit in a
 * store rather than a context value, so a change re-renders only the rows whose count changed.
 */
export const PullRequestCountsProvider = ({ children, threadIds }: { children: ReactNode; threadIds: ReadonlyArray<string> }) => {
    const ready = useAfterFirstPaint();
    const counts = usePullRequestCounts(threadIds, ready);
    const [store] = useState(() =>
        createStore<PullRequestCounts>(() => {
            return { counts };
        }),
    );

    useLayoutEffect(() => {
        store.setState({ counts });
    }, [counts, store]);

    return <PullRequestCountsContext value={store}>{children}</PullRequestCountsContext>;
};

/** How many pull requests one thread is linked to: `0` outside a provider, or before the counts arrive. */
export const usePullRequestCount = (threadId: string): number =>
    useStore(use(PullRequestCountsContext) ?? NO_COUNTS, (state: PullRequestCounts) => state.counts.get(threadId) ?? 0);
