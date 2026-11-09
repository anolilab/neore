import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * One live read of a pane's title, goal, parent relationship and child threads, so a pane holds a
 * single subscription instead of four. `null` data means the thread cannot be read.
 */
export const useThreadPaneState = (threadId: string | undefined, options: { enabled: boolean }) => {
    const crpc = useCRPC();
    // The proof is part of the read's arguments, so the pane refreshes when its chat is unlocked or relocked.
    const unlockProof = useUnlockProof(threadId);

    return useQuery(
        crpc.chat.composite.getThreadPaneState.queryOptions(options.enabled && threadId ? { threadId: threadId as Id<"threads">, unlockProof } : skipToken),
    );
};
