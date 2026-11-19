import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/** Whether the person follows a thread: on gets new-reply notifications, muted gets none, off gets none. */
export type ThreadFollowState = "on" | "off" | "muted";

/**
 * The caller's follow state on one thread, and a setter. `enabled` is false while nothing needs the state (a closed
 * menu): the query then never runs, so a list of rows opens no request per thread. The thread id stays fixed either
 * way, so a change still in flight keeps its mutation scope when the menu closes.
 */
export const useThreadFollow = (threadId: string, { enabled }: { enabled: boolean }) => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    // TODO(anolilab/lunora#1628): not live, because a patch to a `.global()` row does not re-run live queries yet; a live
    // query would answer the refetch below from its stale subscription.
    const { data, error: loadError } = useQuery(
        crpc.chat.follows.functions.getThreadFollow.queryOptions(enabled ? { threadId: threadId as Id<"threads"> } : skipToken, { live: false }),
    );
    const { isPending, mutate } = useMutation({
        ...crpc.chat.follows.functions.setThreadFollow.mutationOptions(),
        // One change at a time per thread, across every menu that shows it, so they reach the server in the order chosen.
        scope: { id: `thread-follow:${threadId}` },
        onError: (error: Error) => {
            console.error("Failed to change the thread follow state:", error);
            showError(error);
        },
        onSuccess: async (_data, { threadId: changedThreadId }) => {
            await queryClient.invalidateQueries({ queryKey: crpc.chat.follows.functions.getThreadFollow.queryKey({ threadId: changedThreadId }) });
        },
    });

    return {
        error: loadError,
        isPending,
        setState: (state: ThreadFollowState) => {
            mutate({ state, threadId: threadId as Id<"threads"> });
        },
        state: data?.state as ThreadFollowState | undefined,
    };
};
