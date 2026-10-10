/**
 * The app's TanStack QueryClient.
 *
 * Ported from the previous query-client.ts, which took the old QueryClient
 * from a helper library purely to borrow its `queryFn()` and `hashFn()` as defaults. Lunora
 * needs neither: `lunoraQueryOptions` — which every `crpc.*.queryOptions()` call
 * goes through — supplies its own `queryFn` and `queryKey`, so there is nothing
 * for a default to do and no client to thread in.
 *
 * The retry policy is the part worth keeping, and it is unchanged in behaviour:
 * deterministic client errors are never retried, auth errors get two attempts to
 * cover the reconnection race where a query fires before the refreshed JWT has
 * propagated, everything else gets three.
 */
import { getErrorCode, isForbiddenError, isRateLimitedError } from "@lunora/react";
import type { Query } from "@tanstack/react-query";
import { defaultShouldDehydrateQuery, QueryCache, QueryClient } from "@tanstack/react-query";

import { isAuthError } from "../utilities";

/**
 * Hydration configuration for TanStack Query.
 * Used for SSR/SSG scenarios with TanStack Router.
 */
export const hydrationConfig = {
    dehydrate: {
        shouldDehydrateQuery: (query: Query) => defaultShouldDehydrateQuery(query) || query.state.status === "pending",
        shouldRedactErrors: () => false,
    },
};

/**
 * The previous `isCRPCError` predicate was "this came from the backend at all". Lunora
 * has no single predicate for that, but `getErrorCode` returns a code only for
 * errors it recognises — which is the same question.
 */
const isBackendError = (error: unknown): boolean => getErrorCode(error) !== undefined;

export const createQueryClient = (): QueryClient =>
    new QueryClient({
        defaultOptions: {
            ...hydrationConfig,
            queries: {
                // Skip retry for deterministic client errors (4xx, validation errors)
                retry: (failureCount, error) => {
                    if (isBackendError(error) && !isAuthError(error)) {
                        return false;
                    }

                    if (isRateLimitedError(error) || isForbiddenError(error)) {
                        return false;
                    }

                    // Two retries with backoff (~6s) is enough for the refreshed
                    // token to reach the backend.
                    if (isAuthError(error)) {
                        return failureCount < 2;
                    }

                    return failureCount < 3;
                },
                // Exponential backoff with max 30s
                retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 30_000),
                staleTime: 30_000,
            },
        },
        queryCache: new QueryCache({
            onError: (error) => {
                if (isRateLimitedError(error)) {
                    console.warn("[lunora] Rate limited:", getErrorCode(error));

                    return;
                }

                // Auth errors are expected while a token is loading; everything else
                // from the backend is worth seeing.
                if (isBackendError(error) && !isAuthError(error)) {
                    console.warn(`[lunora] ${getErrorCode(error)}:`, error instanceof Error ? error.message : String(error));
                }
            },
        }),
    });
