import { useAuthState } from "@lunora/react";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { useThreadListPlaceholder } from "@/features/chat/thread-list/hooks/use-thread-list-cache";

/** The sidebar's thread list (`api.chat.composite.getThreadListData`), keyed by the cRPC shim as `["lunora", <dispatch key>, args]`. */
const THREAD_LIST_KEY = ["lunora", "chat_composite:getThreadListData"] as const;

const hasCachedThreadList = (queryClient: QueryClient): boolean =>
    queryClient.getQueriesData({ queryKey: THREAD_LIST_KEY }).some(([, data]) => data !== undefined);

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
 */
const useHasCachedAppData = (): boolean => {
    const queryClient = useQueryClient();
    const { isAuthenticated, isLoading } = useAuthState();
    const persisted = useThreadListPlaceholder();
    const subscribe = useCallback((onChange: () => void) => queryClient.getQueryCache().subscribe(onChange), [queryClient]);
    const cached = useSyncExternalStore(subscribe, () => hasCachedThreadList(queryClient), getServerSnapshot);

    return isAuthenticated && !isLoading && (cached || persisted !== undefined);
};

export default useHasCachedAppData;
