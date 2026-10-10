"use client";

import { skipToken, useQuery } from "@tanstack/react-query";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

/**
 * The user's threads, for the branch/delete handlers.
 *
 * Read from `chat_composite:getThreadListData` — the query the sidebar already
 * holds, same key, so this costs no request. It used to run its own
 * `chat_functions:getThreads`, a second copy of the same page fired on every
 * first paint of /chat (the command palette and the thread list both mount the
 * handlers), queued on the `__root__` shard beside the first.
 * @param enabled If false, skips the query to avoid unauthenticated errors
 */
const useAllThreadsData = (enabled: boolean = true) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();
    const shouldQuery = enabled && isAuthenticated && !isLoading;

    const { data } = useQuery(crpc.chat.composite.getThreadListData.queryOptions(shouldQuery ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS } : skipToken));

    return {
        lunora: data?.threads.page ?? [],
    };
};

export default useAllThreadsData;
