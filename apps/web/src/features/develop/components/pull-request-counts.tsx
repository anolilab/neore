import type { ReactNode } from "react";
import { createContext, use } from "react";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";

import { usePullRequestCounts } from "../lib/use-develop";

const PullRequestCountsContext = createContext<ReadonlyMap<string, number>>(new Map());

/** Reads the linked pull request counts once for the threads a list shows; each row then reads its own from here. */
export const PullRequestCountsProvider = ({ children, threadIds }: { children: ReactNode; threadIds: ReadonlyArray<string> }) => {
    const ready = useAfterFirstPaint();
    const counts = usePullRequestCounts(threadIds, ready);

    return <PullRequestCountsContext value={counts}>{children}</PullRequestCountsContext>;
};

/** How many pull requests one thread is linked to: `0` outside a provider, or before the counts arrive. */
export const usePullRequestCount = (threadId: string): number => use(PullRequestCountsContext).get(threadId) ?? 0;
