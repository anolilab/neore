import type { NetworkState } from "expo-network";
import { addNetworkStateListener, getNetworkStateAsync } from "expo-network";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

import { useAuth } from "../auth/auth-state";
import { getClient } from "../lib/lunora";
import type { ScopedCache } from "./cache";
import { INITIAL_CONNECTIVITY, isOffline as isOfflineState, reduceConnectivity } from "./connectivity";
import { getOfflineCache } from "./database";
import { OfflineContext } from "./offline-context";
import { createReconnectRefresher } from "./reconnect";

/** While offline for a reason the device cannot report (a server that does not answer), read again this often. */
const RETRY_MS = 15_000;

const nextTick = (tick: number): number => tick + 1;

const isReachable = (state: NetworkState): boolean => state.isConnected !== false && state.isInternetReachable !== false;

/**
 * Tracks whether the app is offline (no network, the live socket down, or the last read failing on the network),
 * binds the cache to the signed-in account and empties it on sign-out. Everything it exposes is for reading:
 * coming back online moves `refreshTick` and nothing else.
 */
export const OfflineProvider = ({ children }: { children: ReactNode }) => {
    const { retryToken, status, user } = useAuth();
    const [connectivity, dispatch] = useReducer(reduceConnectivity, INITIAL_CONNECTIVITY);
    const [refreshTick, setRefreshTick] = useState(0);
    const [bound, setBound] = useState<{ cache: ScopedCache; userId: string } | undefined>();
    const userId = user?.id;
    const isOffline = isOfflineState(connectivity);
    const wasOffline = useRef(false);
    // Coming back online reads again, and mints a token first if the one held may have lapsed or was never fetched.
    const refresher = useRef(
        createReconnectRefresher(() => {
            retryToken();
            setRefreshTick(nextTick);
        }),
    );

    useEffect(() => {
        const subscription = addNetworkStateListener((state) => dispatch({ network: isReachable(state), type: "network" }));
        const initial = async () => {
            try {
                dispatch({ network: isReachable(await getNetworkStateAsync()), type: "network" });
            } catch {
                // Unknown stays "not known to be offline"; a failed read will say otherwise.
            }
        };

        initial();

        const unsubscribe = getClient().onConnectionStatus((socket) => dispatch({ socket, type: "socket" }));

        return () => {
            subscription.remove();
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        refresher.current.update(isOffline);

        // One announcement per change, from here and not from each screen's banner: the stack keeps several screens mounted.
        // iOS ignores live-region props, so this is what a VoiceOver user hears; Android reads the banner's live region.
        if (wasOffline.current !== isOffline) {
            wasOffline.current = isOffline;

            if (Platform.OS === "ios") {
                AccessibilityInfo.announceForAccessibility(isOffline ? "You are offline. Showing saved data." : "Back online.");
            }
        }
    }, [isOffline]);

    useEffect(() => {
        if (!isOffline || connectivity.network === false) {
            return undefined;
        }

        const timer = setInterval(setRefreshTick, RETRY_MS, nextTick);

        return () => clearInterval(timer);
    }, [connectivity.network, isOffline]);

    useEffect(() => {
        const offlineCache = getOfflineCache();
        let isCancelled = false;

        const run = async () => {
            try {
                if (status === "signed-out") {
                    await offlineCache.clear();
                } else if (status === "signed-in" && userId !== undefined) {
                    await offlineCache.bindOwner(userId);

                    if (!isCancelled) {
                        setBound({ cache: offlineCache.forOwner(userId), userId });
                    }
                }
            } catch (error) {
                // eslint-disable-next-line no-console -- no logger in the app; the app carries on without a cache, but not silently
                console.warn("Could not update the offline cache.", error);
            }
        };

        run();

        return () => {
            isCancelled = true;
        };
    }, [status, userId]);

    const reportRead = useCallback((outcome: "failed" | "succeeded") => {
        dispatch({ type: outcome === "failed" ? "request-failed" : "request-succeeded" });
    }, []);

    const cache = status === "signed-in" && bound !== undefined && bound.userId === userId ? bound.cache : undefined;
    const value = useMemo(() => {
        return { cache, isOffline, refreshTick, reportRead };
    }, [cache, isOffline, refreshTick, reportRead]);

    return <OfflineContext value={value}>{children}</OfflineContext>;
};
