"use client";

import { isThreadShardKnown, noteThreadShard } from "@neore/client-runtime";
import type { QueryClient } from "@tanstack/react-query";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

interface ThreadListPages {
    temporaryThreads?: { page?: { _id: string }[] };
    threads?: { page?: { _id: string }[] };
}

/** Whether `threadId` is in a thread list page already in the cache — its own or its temporary chats — then it is the caller's own. */
export const isListedThread = (queryClient: QueryClient, threadId: string): boolean =>
    queryClient
        .getQueriesData<ThreadListPages>({ queryKey: ["lunora", "chat_composite:getThreadListData"] })
        .some(([, data]) => [...(data?.threads?.page ?? []), ...(data?.temporaryThreads?.page ?? [])].some((thread) => thread._id === threadId));

/**
 * Settle which shard `threadId` lives on before anything queries it:
 * the caller's own, or — for a thread shared
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
