import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import type { ThreadTag } from "./thread-tag-logic";
import { withThreadTagIds } from "./thread-tag-logic";

/**
 * The user's tags, read from the `getThreadListData` cache entry the thread
 * list already holds — same query options, so no extra request.
 */
export const useThreadTags = (): ThreadTag[] | undefined => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();
    const { data } = useQuery(
        crpc.chat.composite.getThreadListData.queryOptions(isAuthenticated && !isLoading ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS } : skipToken),
    );

    return data?.tags;
};

/** Query key of the thread-list entry that carries the tags. */
const useThreadListQueryKey = () => {
    const crpc = useCRPC();

    // Memoised: a fresh key array per render would churn every callback built on it.
    return useMemo(() => crpc.chat.composite.getThreadListData.queryKey({ paginationOpts: THREAD_LIST_PAGINATION_OPTS }), [crpc]);
};

/**
 * The thread list is a live query, so a tag mutation's own push normally
 * updates it. This invalidation is the fallback for when the subscription is
 * unavailable; while one is open it is answered from it without an RPC.
 */
const useRefreshThreadList = () => {
    const queryClient = useQueryClient();
    const listQueryKey = useThreadListQueryKey();

    return useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: listQueryKey });
    }, [queryClient, listQueryKey]);
};

/** Tag management: create, rename/recolor, reorder, delete. */
export const useThreadTagMutations = () => {
    const crpc = useCRPC();
    const refreshList = useRefreshThreadList();

    const createTag = useMutation(crpc.chat.tags.functions.createThreadTag.mutationOptions({ onSuccess: refreshList }));
    const updateTag = useMutation(crpc.chat.tags.functions.updateThreadTag.mutationOptions({ onSuccess: refreshList }));
    const deleteTag = useMutation(crpc.chat.tags.functions.deleteThreadTag.mutationOptions({ onSuccess: refreshList }));
    const reorderTags = useMutation(crpc.chat.tags.functions.reorderThreadTags.mutationOptions({ onSettled: refreshList }));

    return { createTag, deleteTag, reorderTags, updateTag };
};

/**
 * Assigns or unassigns one tag on one thread. Patches the cached list first so
 * the chip appears without waiting for the round trip; the refetch afterwards
 * reconciles either way.
 */
export const useSetThreadTagAssigned = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const listQueryKey = useThreadListQueryKey();
    const refreshList = useRefreshThreadList();
    const { mutateAsync } = useMutation(crpc.chat.tags.functions.setThreadTagAssigned.mutationOptions({ onSettled: refreshList }));

    return useCallback(
        async (threadId: string, tagId: string, assigned: boolean, currentTagIds: ReadonlyArray<string> | undefined) => {
            const current = currentTagIds ?? [];
            const optimistic = assigned ? [...new Set([...current, tagId])] : current.filter((id) => id !== tagId);

            await queryClient.cancelQueries({ queryKey: listQueryKey });
            queryClient.setQueryData(listQueryKey, (previous: Parameters<typeof withThreadTagIds>[0] | undefined) =>
                previous ? withThreadTagIds(previous, threadId, optimistic) : previous,
            );

            // Ids reach the UI as plain strings but always come from backend documents.
            await mutateAsync({
                assigned,
                tagId: tagId as Id<"threadTags">,
                threadId: threadId as Id<"threads">,
            });
        },
        [queryClient, listQueryKey, mutateAsync],
    );
};
