"use client";

/**
 * Hook for preloading thread data and messages on hover.
 *
 * This hook provides a function that preloads thread data into Lunora's cache
 * by calling watchQuery directly. This ensures that when the user navigates
 * to the thread, the data is already cached and displays instantly.
 *
 * The preload uses Lunora's internal cache which is shared with cRPC queries.
 */

import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useEffect, useRef } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import { DEFAULT_PAGINATION_OPTS } from "../constants/query-options";

// How long to keep preloaded subscriptions alive (in ms)
const PRELOAD_SUBSCRIPTION_TTL = 30_000; // 30 seconds

interface PreloadSubscription {
    timeoutId: NodeJS.Timeout;
    unsubMessages?: () => void;
    unsubThread?: () => void;
}

// Safe unsubscribe helper that catches errors from Lunora client
const safeUnsub = (unsub?: () => void) => {
    if (unsub) {
        try {
            unsub();
        } catch {
            // Ignore errors during unsubscribe (can happen if query failed)
        }
    }
};

/**
 * Hook that provides a function to preload thread data and messages on hover.
 *
 * Usage:
 * ```tsx
 * const preloadThread = usePreloadThread();
 *
 * const handleMouseEnter = () => {
 *   preloadThread(threadId);
 * };
 * ```
 */
const usePreloadThread = () => {
    const lunora = useLunora();
    const activePreloads = useRef<Map<string, PreloadSubscription>>(new Map());

    // Release every in-flight preload on unmount: the TTL timers and the
    // subscriptions they own would otherwise outlive the component.
    useEffect(() => {
        const preloads = activePreloads.current;

        return () => {
            for (const subscription of preloads.values()) {
                clearTimeout(subscription.timeoutId);
                safeUnsub(subscription.unsubThread);
                safeUnsub(subscription.unsubMessages);
            }

            preloads.clear();
        };
    }, []);

    const preloadThread = (threadId: string) => {
        // Guard against ref being cleared
        if (!activePreloads.current) {
            return;
        }

        // Skip if already preloading this thread
        if (activePreloads.current.has(threadId)) {
            return;
        }

        let unsubThread: (() => void) | undefined;
        let unsubMessages: (() => void) | undefined;

        try {
            // Start watching thread data and messages in parallel. The callbacks are
            // intentionally empty: the point is to warm the client's query cache so the
            // real subscription on the thread route resolves instantly.
            // `threadId` is a route param that only ever names a real thread.
            unsubThread = lunora.subscribe(
                api.chat.functions.getThread,
                {
                    threadId: threadId as Id<"threads">,
                },
                () => {},
            );

            unsubMessages = lunora.subscribe(
                api.chat.functions.getThreadUIMessages,
                {
                    paginationOpts: DEFAULT_PAGINATION_OPTS,
                    threadId: threadId as Id<"threads">,
                },
                () => {},
            );
        } catch {
            // Ignore errors during watch setup (can happen if not authenticated)
            return;
        }

        // Cleanup after TTL
        const timeoutId = setTimeout(() => {
            // Guard against ref being cleared (e.g., during unmount)
            if (!activePreloads.current) {
                return;
            }

            const subscription = activePreloads.current.get(threadId);

            if (subscription) {
                safeUnsub(subscription.unsubThread);
                safeUnsub(subscription.unsubMessages);
                activePreloads.current.delete(threadId);
            }
        }, PRELOAD_SUBSCRIPTION_TTL);

        activePreloads.current.set(threadId, {
            timeoutId,
            unsubMessages,
            unsubThread,
        });
    };

    return preloadThread;
};

export default usePreloadThread;
