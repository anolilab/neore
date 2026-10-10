"use client";

/**
 * useHydratedMessages - A hook that provides instant message loading
 *
 * This hook combines TanStack Query (for instant cached data) with
 * Lunora's useUIMessages (for real-time streaming updates).
 *
 * The flow:
 * 1. TanStack Query provides cached data instantly (from route loader)
 * 2. Lunora subscription starts in parallel
 * 3. Once Lunora has data, we switch to real-time updates
 * 4. Streaming continues to work via Lunora
 */

import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import type { UIMessage } from "@/lib/agent";
import { useUIMessages } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";

import { DEFAULT_PAGINATION_OPTS } from "../constants/query-options";

interface UseHydratedMessagesOptions {
    initialNumItems?: number;
    threadId: string | undefined;
}

interface UseHydratedMessagesResult {
    isHydrated: boolean;
    loadMore: (numberItems: number) => void;
    messages: UIMessage[];
    status: "LoadingFirstPage" | "LoadingMore" | "Exhausted" | "CanLoadMore";
}

const useHydratedMessages = ({ initialNumItems: initialNumberItems = 20, threadId }: UseHydratedMessagesOptions): UseHydratedMessagesResult => {
    const crpc = useCRPC();

    // Track if we've received data from Lunora
    const [lunoraHasData, setLunoraHasData] = useState(false);
    const lunoraDataRef = useRef<UIMessage[] | null>(null);

    // Reset stale state when threadId changes to prevent flash of previous thread's messages
    const previousThreadIdRef = useRef(threadId);

    useEffect(() => {
        if (previousThreadIdRef.current === threadId) {
            return;
        }

        previousThreadIdRef.current = threadId;
        setLunoraHasData(false);
        lunoraDataRef.current = null;
    }, [threadId]);

    // Stabilize query options to prevent unnecessary re-subscriptions
    const queryOptions = useMemo(
        () =>
            threadId
                ? {
                      paginationOpts:
                          initialNumberItems === 20
                              ? DEFAULT_PAGINATION_OPTS
                              : { cursor: null, endCursor: undefined, id: undefined, numItems: initialNumberItems },
                      // `threadId` is a plain string prop threaded down from the
                      // `/chat/$threadId` route param, which only matches real threads.
                      threadId: threadId as Id<"threads">,
                  }
                : skipToken,
        [threadId, initialNumberItems],
    );

    // 1. TanStack Query - instant data from loader cache
    const { data: cachedData, isSuccess: hasCachedData } = useTanstackQuery({
        // Not live: `useUIMessages` below already subscribes to these pages.
        ...crpc.chat.functions.getThreadUIMessages.queryOptions(queryOptions, { live: false }),
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        // Don't refetch - we'll use Lunora for real-time updates
        staleTime: Infinity,
    });

    // 2. Lunora - real-time updates (streaming handled separately via getActiveStreamForThread)
    const {
        loadMore,
        results: lunoraMessages,
        status: lunoraStatus,
    } = useUIMessages(api.chat.functions.getThreadUIMessages, threadId ? { threadId: threadId as Id<"threads"> } : "skip", {
        initialNumItems: initialNumberItems,
    });

    // Track when Lunora has data
    useEffect(() => {
        if (lunoraStatus === "LoadingFirstPage" || lunoraMessages.length === 0) {
            return;
        }

        lunoraDataRef.current = lunoraMessages as UIMessage[];
        setLunoraHasData(true);
    }, [lunoraStatus, lunoraMessages]);

    // Determine which data source to use
    const result = useMemo((): UseHydratedMessagesResult => {
        // If Lunora has real-time data, use it (for streaming support)
        if (lunoraHasData || (lunoraStatus !== "LoadingFirstPage" && lunoraMessages.length > 0)) {
            return {
                isHydrated: true,
                loadMore,
                messages: lunoraMessages as UIMessage[],
                status: lunoraStatus,
            };
        }

        // Parse cached data once
        const paginatedData = cachedData as { isDone?: boolean; page?: UIMessage[] } | undefined;
        const cachedMessages = paginatedData?.page;

        const hasCachedMessages = hasCachedData && cachedMessages && Array.isArray(cachedMessages) && cachedMessages.length > 0;

        // If Lunora is still loading but we have cached data, use it for instant display
        // This provides a smooth experience - cached data shows immediately while Lunora initializes
        if (hasCachedMessages && lunoraStatus === "LoadingFirstPage") {
            return {
                isHydrated: false,
                loadMore,
                messages: cachedMessages,
                // Report as CanLoadMore since we have data (Lunora will take over for pagination)
                status: paginatedData?.isDone ? "Exhausted" : "CanLoadMore",
            };
        }

        // If Lunora has data but status hasn't updated yet, use Lunora data
        if (lunoraMessages.length > 0) {
            return {
                isHydrated: true,
                loadMore,
                messages: lunoraMessages as UIMessage[],
                status: lunoraStatus,
            };
        }

        // No data yet - still loading
        return {
            isHydrated: false,
            loadMore,
            messages: [],
            status: "LoadingFirstPage",
        };
    }, [lunoraHasData, lunoraMessages, lunoraStatus, hasCachedData, cachedData, loadMore]);

    return result;
};

export default useHydratedMessages;
