import { useAuthState } from "@lunora/react";
import type { QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { useThreadListPlaceholder } from "@/features/chat/thread-list/hooks/use-thread-list-cache";

/** The sidebar's thread list (`api.chat.composite.getThreadListData`), keyed by the cRPC shim as `["lunora", <dispatch key>, args]`. */
const THREAD_LIST_KEY = ["lunora", "chat_composite:getThreadListData"] as const;

const hasThreadList = (queryClient: QueryClient): boolean =>
    queryClient
        .getQueryCache()
        .findAll({ queryKey: THREAD_LIST_KEY })
        .some((query) => query.state.data !== undefined);

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
 * The query key carries no account, so a cached list is the current account's
 * only because the live-query manager removes it as another account's token
 * lands (`packages/client-runtime/src/live-queries.ts`); a sign-out or an expiry
 * clears the whole cache.
 */
const useHasCachedAppData = (): boolean => {
    const queryClient = useQueryClient();
    const { isAuthenticated, isLoading } = useAuthState();
    const persisted = useThreadListPlaceholder();

    const subscribe = useCallback(
        (onChange: () => void) =>
            queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
                if (changesThreadList(event)) {
                    onChange();
                }
            }),
        [queryClient],
    );
    const getSnapshot = useCallback(() => hasThreadList(queryClient), [queryClient]);
    const cached = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    return isAuthenticated && !isLoading && (cached || persisted !== undefined);
};

export default useHasCachedAppData;
