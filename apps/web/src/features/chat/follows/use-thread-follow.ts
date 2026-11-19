import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/** Whether the person follows a thread: on gets new-reply notifications, muted gets none, off gets none. */
export type ThreadFollowState = "on" | "off" | "muted";

/**
 * The caller's follow state on one thread, and a setter. Pass `null` while nothing needs the state (a closed
 * menu): the query then never runs, so a list of rows opens no subscription per thread.
 */
export const useThreadFollow = (threadId: string | null) => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    // TODO(anolilab/lunora#1628): not live, because a patch to a `.global()` row does not re-run live queries yet; a live
    // query would answer the refetch below from its stale subscription.
    const { data } = useQuery(
        crpc.chat.follows.functions.getThreadFollow.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken, { live: false }),
    );
    const { isPending, mutate } = useMutation({
        ...crpc.chat.follows.functions.setThreadFollow.mutationOptions(),
        onError: (error: Error) => {
            console.error("Failed to change the thread follow state:", error);
            showError(error);
        },
        onSuccess: async (_data, { threadId }) => {
            await queryClient.invalidateQueries({ queryKey: crpc.chat.follows.functions.getThreadFollow.queryKey({ threadId }) });
        },
    });

    return {
        isPending,
        setState: (state: ThreadFollowState) => {
            if (threadId) {
                mutate({ state, threadId: threadId as Id<"threads"> });
            }
        },
        state: data?.state as ThreadFollowState | undefined,
    };
};
