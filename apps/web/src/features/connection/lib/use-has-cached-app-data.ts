import { useAuthState } from "@lunora/react";
import type { QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";

import { useCacheUserId, useThreadListPlaceholder } from "@/features/chat/thread-list/hooks/use-thread-list-cache";

/** The sidebar's thread list (`api.chat.composite.getThreadListData`), keyed by the cRPC shim as `["lunora", <dispatch key>, args]`. */
const THREAD_LIST_KEY = ["lunora", "chat_composite:getThreadListData"] as const;

/** Each cached thread-list result, by query hash, as when it was last delivered. */
const threadListResults = (queryClient: QueryClient): ReadonlyMap<string, number> =>
    new Map(
        queryClient
            .getQueryCache()
            .findAll({ queryKey: THREAD_LIST_KEY })
            .filter((query) => query.state.data !== undefined)
            .map((query) => [query.queryHash, query.state.dataUpdatedAt]),
    );

const NOTHING_INHERITED: ReadonlyMap<string, number> = new Map();

/** The account whose list counts, and the results already cached when it took over: those may be the previous account's. */
interface Owner {
    readonly inherited: ReadonlyMap<string, number>;
    readonly userId: string | undefined;
}

/** A result counts unless it is one the account inherited and the query has not delivered since (a refetch with equal data still does). */
const hasOwnResult = (queryClient: QueryClient, inherited: ReadonlyMap<string, number>): boolean =>
    [...threadListResults(queryClient)].some(([hash, updatedAt]) => inherited.get(hash) !== updatedAt);

/** Only what can change the answer: a thread-list query added, removed, or given new data. Live pushes to other queries are not. */
const CHANGES: ReadonlySet<QueryCacheNotifyEvent["type"]> = new Set(["added", "removed", "updated"]);

const changesThreadList = (event: QueryCacheNotifyEvent): boolean => CHANGES.has(event.type) && event.query.queryKey[1] === THREAD_LIST_KEY[1];

const getServerSnapshot = (): boolean => false;

/**
 * Whether the app has something of the account's to show without the network.
 * When it has, losing the connection keeps the app on screen with the banner;
 * when it has not, the full-screen offline view explains the empty window.
 *
 * That is the thread list, in the query cache or the signed-in user's stored copy
 * the sidebar shows as its placeholder, and only while the auth gate is open: a
 * client with no token (or one still resolving it) renders a skeleton whatever is
 * cached. It follows the query cache, so a list that lands after the screen has
 * covered the window lifts it.
 *
 * The query key carries no account, so after a switch from one account to
 * another without a reload, a result cached before the switch may be the
 * previous account's (the same hold as `usePersistThreadList`): it counts again
 * only once the query has delivered a new result.
 */
const useHasCachedAppData = (): boolean => {
    const queryClient = useQueryClient();
    const { isAuthenticated, isLoading } = useAuthState();
    const persisted = useThreadListPlaceholder();
    const userId = useCacheUserId();
    const [owner, setOwner] = useState<Owner>({ inherited: NOTHING_INHERITED, userId });

    if (userId !== undefined && owner.userId !== userId) {
        // On the first load nothing is inherited; from another account (also across a sign-out, which clears the cache), what is cached.
        setOwner({ inherited: owner.userId === undefined ? NOTHING_INHERITED : threadListResults(queryClient), userId });
    }

    const subscribe = useCallback(
        (onChange: () => void) =>
            queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
                if (changesThreadList(event)) {
                    onChange();
                }
            }),
        [queryClient],
    );
    const getSnapshot = useCallback(() => hasOwnResult(queryClient, owner.inherited), [owner.inherited, queryClient]);
    const cached = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    return isAuthenticated && !isLoading && (cached || persisted !== undefined);
};

export default useHasCachedAppData;
