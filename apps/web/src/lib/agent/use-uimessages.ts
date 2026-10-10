import type { ArgsOf, FunctionReference, PaginatedArgs, UsePaginatedQueryResult } from "@lunora/react";
// `usePaginatedQuery` from `@lunora/react`, not the old helpers — the
// helper version constrains on the old PaginatedQueryReference, which a
// Lunora `FunctionReference` is not.
import { usePaginatedQuery } from "@lunora/react";
import { sorted } from "@neore/backend/agent/shared";
import type { SyncStreamsReturnValue } from "@neore/backend/agent/types";
import type { UIMessage, UIStatus } from "@neore/backend/agent/ui-messages";
import { combineUIMessages } from "@neore/backend/agent/ui-messages";
import type { StreamArgs } from "@neore/backend/agent/validators";
import { useLayoutEffect, useMemo, useRef } from "react";

import { shardOptionsFor } from "@/lib/lunora/shard-routing";

import { shareUnchangedMessages } from "./share-unchanged-messages";
import type { BetterOmit, ErrorMessage, Expand } from "./type-utilities";
import type { StreamQuery, StreamQueryArgs } from "./types";
import useStreamingUIMessages from "./use-streaming-uimessages";

("use client");

// Debug streaming performance - set to true for debugging
const IS_DEBUG_STREAMING = false;

export type UIMessageLike = {
    order: number;
    parts: UIMessage["parts"];
    role: UIMessage["role"];
    status: UIStatus;
    stepOrder: number;
};

/**
 * The server's page shape, declared locally.
 *
 * `PaginationOptions` / `PaginationResult` came from `lunorash/server`, which is
 * a SERVER package and not a dependency of `apps/web`. `@lunora/react` exposes no
 * client-side equivalent, and these two are small and stable enough to state
 * here rather than reach across the boundary for.
 */
export interface PaginationOptions {
    cursor: null | string;
    numItems: number;
}

export interface PaginationResult<T> {
    continueCursor: null | string;
    isDone: boolean;
    page: T[];
}

// `FunctionReference<Kind, Args, Return>` — three parameters. the old took four,
// with a visibility slot ("public" / "internal") between the kind and the args.
// Lunora encodes visibility by which generated object the reference lives on
// (`api` vs `internal`) rather than in the type.
export type UIMessagesQuery<Args = unknown, M extends UIMessageLike = UIMessageLike> = FunctionReference<
    "query",
    Args & {
        paginationOpts: PaginationOptions;

        /**
         * If { stream: true } is passed, it will also query for stream deltas.
         * In order for this to work, the query must take as an argument streamArgs.
         */
        streamArgs?: StreamArgs;
        threadId: string;
    },
    PaginationResult<M> & { streams?: SyncStreamsReturnValue }
>;

export type UIMessagesQueryArgs<Query extends UIMessagesQuery<unknown, UIMessageLike>> =
    Query extends UIMessagesQuery<unknown, UIMessageLike> ? Expand<BetterOmit<ArgsOf<Query>, "paginationOpts" | "streamArgs">> : never;

export type UIMessagesQueryResult<Query extends UIMessagesQuery<unknown, UIMessageLike>> = Query extends UIMessagesQuery<unknown, infer M> ? M : never;

export const dedupeMessages = <
    M extends {
        order: number;
        status: UIStatus;
        stepOrder: number;
    },
>(
    messages: M[],
    streamMessages: M[],
): M[] => {
    const msgs: M[] = [];

    const allMessages = sorted([...messages, ...streamMessages]);

    for (const message of allMessages) {
        const last = msgs.at(-1);

        if (!last || last.order !== message.order || last.stepOrder !== message.stepOrder) {
            msgs.push(message);
        } else if ((last.status === "pending" || last.status === "streaming") && message.status !== "pending") {
            // Let's prefer a streaming or finalized message over a pending
            // one.
            msgs[msgs.length - 1] = message;
        }

        // otherwise skip the new one if the previous one (listed) was finalized
    }

    return msgs;
};

/**
 * A hook that fetches UIMessages from a thread.
 *
 * It's similar to useThreadMessages, for endpoints that return UIMessages.
 * The streaming messages are materialized as UIMessages. The rest are passed
 * through from the query.
 *
 * This hook is a wrapper around `usePaginatedQuery` and `useStreamingUIMessages`.
 * It will fetch both full messages and streaming messages, and merge them together.
 *
 * The query must take as arguments `{ threadId, paginationOpts }` and return a
 * pagination result of objects similar to UIMessage:
 *
 * For streaming, it should look like this:
 * ```ts
 * export const listThreadMessages = query({
 *   args: {
 *     threadId: v.string(),
 *     paginationOpts: paginationOptionsValidator,
 *     streamArgs: vStreamArgs,
 *     ... other arguments you want
 *   },
 *   handler: async (ctx, args) => {
 *     // await authorizeThreadAccess(ctx, threadId);
 *     // NOTE: listUIMessages returns UIMessages, not MessageDocs.
 *     const paginated = await listUIMessages(ctx, components.agent, args);
 *     const streams = await syncStreams(ctx, components.agent, args);
 *     // Here you could filter out / modify the documents & stream deltas.
 *     return { ...paginated, streams };
 *   },
 * });
 * ```
 *
 * Then the hook can be used like this:
 * ```ts
 * const { results, status, loadMore } = useUIMessages(
 *   api.myModule.listThreadMessages,
 *   { threadId },
 *   { initialNumItems: 10, stream: true }
 * );
 * ```
 * @param query The query to use to fetch messages.
 * It must take as arguments `{ threadId, paginationOpts }` and return a
 * pagination result of objects similar to UIMessage:
 * Required fields: (role, parts, status, order, stepOrder).
 * To support streaming, it must also take in `streamArgs: vStreamArgs` and
 * return a `streams` object returned from `syncStreams`.
 * @param args The arguments to pass to the query other than `paginationOpts`
 * and `streamArgs`. So `{ threadId }` at minimum, plus any other arguments that
 * you want to pass to the query.
 * @param options The options for the query. Similar to usePaginatedQuery.
 * To enable streaming, pass `stream: true`.
 * @param options.initialNumItems How many persisted messages to load on the
 * first page.
 * @param options.skipStreamIds Stream ids to leave out of the result, for
 * streams the caller renders itself.
 * @param options.stream Whether to merge in-flight streams into the result.
 * @returns The messages. If stream is true, it will return a list of messages
 * that includes both full messages and streaming messages.
 * The streaming messages are materialized as UIMessages. The rest are passed
 * through from the query.
 */
export const useUIMessages = <Query extends UIMessagesQuery<any, any>>(
    query: Query,
    args: UIMessagesQueryArgs<Query> | "skip",
    options: {
        initialNumItems: number;
        skipStreamIds?: string[];
        stream?: Query extends StreamQuery
            ? boolean
            : ErrorMessage<"To enable streaming, your query must take in streamArgs: vStreamArgs and return a streams object returned from syncStreams. See docs.">;
    },
): UsePaginatedQueryResult<UIMessagesQueryResult<Query>> => {
    // These are full messages
    // The result is re-stated as `UIMessagesQueryResult<Query>[]`.
    //
    // `usePaginatedQuery` types its page as `PageItemOf<F>`, derived from the
    // reference's declared RETURN. `UIMessagesQueryResult<Query>` derives the same
    // message type from the query's `M` parameter. They are the same type for every
    // real query, but TypeScript cannot see that through two unresolved generics —
    // so `.order` and `.status` came back missing on a value that has both.
    // A shared thread's messages live on its owner's shard (`lib/lunora/shard-routing.ts`).
    const paginated = usePaginatedQuery(query, args as PaginatedArgs<Query> | "skip", {
        initialNumItems: options.initialNumItems,
        ...shardOptionsFor(args),
    }) as UsePaginatedQueryResult<UIMessagesQueryResult<Query>>;

    const startOrder = paginated.results.length > 0 ? Math.min(...paginated.results.map((m) => m.order)) : 0;
    // These are streaming messages that will not include full messages.
    const streamMessages = useStreamingUIMessages(
        query as StreamQuery<UIMessagesQueryArgs<Query>>,
        !options.stream || args === "skip" || paginated.status === "LoadingFirstPage"
            ? "skip"
            : // The streaming hook derives its args from the query reference it was handed, which is
              // the same reference cast above; `paginationOpts` is added because the underlying query
              // still requires it even though only `streams` is read back.
              ({ ...args, paginationOpts: { cursor: null, numItems: 0 } } as StreamQueryArgs<StreamQuery<UIMessagesQueryArgs<Query>>>),
        { skipStreamIds: options.skipStreamIds, startOrder },
    );

    // The last result, so unchanged messages keep their identity across pushes
    // and memoized rows skip them (`shareUnchangedMessages`).
    const previousResultsRef = useRef<UIMessage[]>([]);

    // Manual memo on purpose: the React Compiler bails out of this hook (it reads a ref during render), so this is its only memoization.
    const merged = useMemo(() => {
        // Messages may have been split by pagination. Re-combine them here.
        const combined = combineUIMessages(sorted(paginated.results));
        const deduped = shareUnchangedMessages(previousResultsRef.current, dedupeMessages(combined, streamMessages ?? []));

        // Debug: Log streaming message merge
        if (IS_DEBUG_STREAMING && streamMessages && streamMessages.length > 0) {
            const streamingMsgs = deduped.filter((m) => m.status === "streaming");

            if (streamingMsgs.length > 0) {
                console.log(`[STREAM_DEBUG][useUIMessages] Merged messages`, {
                    combinedCount: combined.length,
                    dedupedCount: deduped.length,
                    paginatedCount: paginated.results.length,
                    streamingCount: streamingMsgs.length,
                    streamingInfo: streamingMsgs.map((m) => {
                        return {
                            order: m.order,
                            partsCount: m.parts?.length ?? 0,
                            stepOrder: m.stepOrder,
                        };
                    }),
                    streamMessagesCount: streamMessages.length,
                });
            }
        }

        return {
            ...paginated,
            results: deduped,
        };
    }, [paginated, streamMessages]);

    useLayoutEffect(() => {
        previousResultsRef.current = merged.results;
    }, [merged]);

    return merged as UIMessagesQueryResult<Query>;
};
