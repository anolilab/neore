"use client";

import type { QueryClient } from "@tanstack/react-query";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";
import { isThreadShardKnown, noteThreadShard } from "@/lib/lunora/shard-routing";

/** Whether `threadId` is in a thread list page already in the cache — then it is the caller's own. */
const isListedThread = (queryClient: QueryClient, threadId: string): boolean =>
    queryClient
        .getQueriesData<{ threads?: { page?: { _id: string }[] } }>({ queryKey: ["lunora", "chat_composite:getThreadListData"] })
        .some(([, data]) => data?.threads?.page?.some((thread) => thread._id === threadId) ?? false);

/**
 * Settle which shard `threadId` lives on before anything queries it
 * (docs/plans/per-user-sharding.md): the caller's own, or — for a thread shared
 * with them — its owner's, which `crpc` then names on every call about it.
 * Returns `true` once the thread's calls can go out.
 *
 * A thread in the caller's cached thread list is their own and settles with no
 * request; anything else asks `chat_sharing.resolveThreadShard` once. A failed
 * lookup settles as "own shard", which is where the thread then is or is not.
 */
export const useThreadShard = (threadId: string | undefined, enabled: boolean = true): boolean => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    if (threadId && enabled && !isThreadShardKnown(threadId) && isListedThread(queryClient, threadId)) {
        noteThreadShard(threadId, null);
    }

    const known = !threadId || !enabled || isThreadShardKnown(threadId);
    const { data, isError, isSuccess } = useQuery({
        ...crpc.chat.sharing.resolveThreadShard.queryOptions(known ? skipToken : { threadId: threadId as string }, { live: false }),
        retry: false,
    });

    if (threadId && !known && (isSuccess || isError)) {
        noteThreadShard(threadId, isSuccess ? data : null);
    }

    return known || isSuccess || isError;
};
