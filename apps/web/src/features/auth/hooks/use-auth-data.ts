import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import authDataCache from "../lib/auth-data-cache";
import { getLocalizedError } from "../lib/utilities";
import type { FetchError } from "../types/data-structure-types";

const useAuthData = <T>({
    cacheKey,
    queryFn,
    staleTime = 10_000, // Default 10 seconds
}: {
    cacheKey?: string;
    queryFn: () => Promise<{ data: T | null; error?: FetchError | null }>;
    staleTime?: number;
}) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();
    const { data: sessionData, isPending: sessionPending } = authClient.useSession();

    // Generate a stable cache key based on the queryFn if not provided
    const queryFunctionReference = useRef(queryFn);

    // Keep the ref in sync after commit — writing it during render is not allowed.
    // This effect is declared before the fetch effect below, so it always runs first.
    useEffect(() => {
        queryFunctionReference.current = queryFn;
    });

    const stableCacheKey = cacheKey || queryFn.toString();

    // Subscribe to cache updates for this key
    const cacheEntry = useSyncExternalStore(
        useCallback((callback) => authDataCache.subscribe(stableCacheKey, callback), [stableCacheKey]),
        useCallback(() => authDataCache.get<T>(stableCacheKey), [stableCacheKey]),
        useCallback(() => authDataCache.get<T>(stableCacheKey), [stableCacheKey]),
    );

    const initialized = useRef(false);
    const previousUserId = useRef<string | undefined>(undefined);
    const [error, setError] = useState<FetchError | null>(null);

    const refetch = useCallback(async () => {
        // Check if there's already an in-flight request for this key
        const existingRequest = authDataCache.getInFlightRequest<{
            data: T | null;
            error?: FetchError | null;
        }>(stableCacheKey);

        if (existingRequest) {
            // Wait for the existing request to complete
            try {
                const result = await existingRequest;

                if (result.error) {
                    setError(result.error);
                } else {
                    setError(null);
                }
            } catch (error_) {
                setError(error_ as FetchError);
            }

            return;
        }

        // Mark as refetching if we have cached data
        if (cacheEntry?.data !== undefined) {
            authDataCache.setRefetching(stableCacheKey, true);
        }

        // Create the fetch promise
        const fetchPromise = queryFunctionReference.current();

        // Store the promise as in-flight
        authDataCache.setInFlightRequest(stableCacheKey, fetchPromise);

        try {
            const { data, error: fetchError } = await fetchPromise;

            if (fetchError) {
                setError(fetchError);
                toast({
                    message: getLocalizedError({ error: fetchError, t }),
                    variant: "error",
                });
            } else {
                setError(null);
            }

            // Update cache with new data
            authDataCache.set(stableCacheKey, data);
        } catch (error_) {
            const fetchError = error_ as FetchError;

            setError(fetchError);
            toast({
                message: getLocalizedError({ error: fetchError, t }),
                variant: "error",
            });
        } finally {
            authDataCache.setRefetching(stableCacheKey, false);
            authDataCache.removeInFlightRequest(stableCacheKey);
        }
    }, [stableCacheKey, toast, cacheEntry, t]);

    const onRefetch = useEffectEvent(() => {
        refetch();
    });

    useEffect(() => {
        if (!sessionData) {
            // Clear cache when session is lost
            authDataCache.setRefetching(stableCacheKey, false);
            authDataCache.clear(stableCacheKey);
            initialized.current = false;
            previousUserId.current = undefined;

            return;
        }

        const currentUserId = sessionData?.user?.id;

        // Check if user ID has changed
        const isUserIdChanged = previousUserId.current !== undefined && previousUserId.current !== currentUserId;

        // If user changed, clear cache to ensure isPending becomes true
        if (isUserIdChanged) {
            authDataCache.clear(stableCacheKey);
        }

        // If we have cached data, we're not pending anymore
        const hasCachedData = cacheEntry?.data !== undefined;

        // Check if data is stale
        const isStale = !cacheEntry || Date.now() - cacheEntry.timestamp > staleTime;

        if (
            (!initialized.current || !hasCachedData || isUserIdChanged || (hasCachedData && isStale)) && // Only fetch if we don't have data or if the data is stale
            (!hasCachedData || isStale)
        ) {
            initialized.current = true;
            onRefetch();
        }

        // Update the previous user ID
        previousUserId.current = currentUserId;
    }, [sessionData, sessionData?.user?.id, stableCacheKey, cacheEntry, staleTime]);

    // Determine if we're in a pending state
    // We're only pending if:
    // 1. Session is still loading, OR
    // 2. We have no cached data and no error
    const isPending = sessionPending || (!cacheEntry?.data && !error);

    return {
        data: cacheEntry?.data ?? null,
        error,
        isPending,
        isRefetching: cacheEntry?.isRefetching ?? false,
        refetch,
    };
};

export default useAuthData;
