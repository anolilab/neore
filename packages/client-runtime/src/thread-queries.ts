/**
 * The Lunora reads that paint a thread and the thread list, as the dispatch keys in a query
 * key's function slot (`["lunora", path, args, shardKey]`). Switching threads waits on these
 * and nothing else, so they get a long cache life (`query-client.ts`) and seed first
 * (`live-queries.ts`).
 */
export const THREAD_QUERY_PATHS: ReadonlySet<string> = new Set([
    "chat_composite:getThreadListData",
    "chat_composite:getThreadPaneState",
    "chat_composite:getThreadWithData",
    "chat_functions:getThread",
    "chat_functions:getThreadUIMessages",
    "chat_streaming:getActiveStreamForThread",
]);

/**
 * How long an unobserved thread read stays in the cache: going back to a thread opened
 * earlier in the session paints at once. Data only: a live subscription still ends
 * `LINGER_MS` after its last observer leaves (`live-queries.ts`), so this keeps no socket open.
 */
export const THREAD_QUERY_GC_TIME_MS = 30 * 60 * 1000;
