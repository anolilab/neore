import type { QueryClient } from "@tanstack/react-query";

/** The sidebar's thread list (`api.chat.composite.getThreadListData`), keyed by the cRPC shim as `["lunora", <dispatch key>, args]`. */
const THREAD_LIST_KEY = ["lunora", "chat_composite:getThreadListData"] as const;

/**
 * Whether the app has something of the account's to show without the network.
 * When it has, losing the connection keeps the app on screen with the banner;
 * when it has not, the full-screen offline view explains the empty window.
 *
 * Today that is the thread list already in the query cache. Anything that
 * restores data before the first render (a persisted query cache) makes this
 * true by filling the same cache; a new source of offline data extends it here.
 */
const hasCachedAppData = (queryClient: QueryClient): boolean =>
    queryClient.getQueriesData({ queryKey: THREAD_LIST_KEY }).some(([, data]) => data !== undefined);

export default hasCachedAppData;
