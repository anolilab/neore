import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * One live read of a pane's title, goal, parent relationship and child threads, so a pane holds a
 * single subscription instead of four. `null` data means the thread cannot be read.
 */
export const useThreadPaneState = (threadId: string | undefined, options: { enabled: boolean }) => {
    const crpc = useCRPC();

    return useQuery(crpc.chat.composite.getThreadPaneState.queryOptions(options.enabled && threadId ? { threadId: threadId as Id<"threads"> } : skipToken));
};
