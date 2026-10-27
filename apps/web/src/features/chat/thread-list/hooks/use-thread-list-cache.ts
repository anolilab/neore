import { tokenSubject } from "@neore/client-runtime";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useCRPCClient } from "@/lib/lunora/crpc";

import {
    getThreadListClearGeneration,
    readThreadListCache,
    subscribeToForeignThreadListClears,
    toThreadListData,
    writeThreadListCache,
} from "../lib/thread-list-cache";

/** Pushes arrive in bursts while a reply streams; the stored copy only needs the last one. */
const WRITE_DEBOUNCE_MS = 1000;

const getServerSubject = (): null => null;

const userIdOf = (token: string | null): string | undefined => {
    const subject = tokenSubject(token);

    // `tokenSubject` falls back to the raw token when it cannot read a `sub`; that is no user id and must never become a storage key.
    return subject && subject !== token ? subject : undefined;
};

/**
 * The signed-in user's id, or `undefined` before there is one. The server
 * snapshot is `null`, so neither the server render nor the hydration render
 * reads the cache; the client snapshot lands right after hydration.
 */
const useCacheUserId = (): string | undefined => {
    const client = useCRPCClient();
    const token = useSyncExternalStore(
        (onChange) => client.onAuthTokenChange(onChange),
        () => client.getAuthToken(),
        getServerSubject,
    );

    return userIdOf(token);
};

/** The stored thread list for the signed-in user, shaped like the query result — for `placeholderData` only. */
export const useThreadListPlaceholder = (): ReturnType<typeof toThreadListData> | undefined => {
    const userId = useCacheUserId();

    return useMemo(() => {
        const persisted = readThreadListCache(userId);

        return persisted && toThreadListData(persisted);
    }, [userId]);
};

/** Keeps the stored copy current with what the network or the live subscription delivered; a placeholder is never written back. */
export const usePersistThreadList = (data: unknown, isPlaceholderData: boolean): void => {
    const client = useCRPCClient();
    const userId = useCacheUserId();
    const clearedElsewhere = useRef(false);

    // Another tab removed this user's list (its sign-out); until this tab sees a fresh token it must not put that list back.
    // A removal that was not a sign-out leaves the session alive, so the next token for it lifts the hold.
    useEffect(() => {
        if (!userId) {
            return undefined;
        }

        const unsubscribeClears = subscribeToForeignThreadListClears(userId, () => {
            clearedElsewhere.current = true;
        });
        const unsubscribeToken = client.onAuthTokenChange(() => {
            clearedElsewhere.current = false;
        });

        return () => {
            unsubscribeClears();
            unsubscribeToken();
            clearedElsewhere.current = false;
        };
    }, [client, userId]);

    useEffect(() => {
        const generation = getThreadListClearGeneration();
        const timer =
            data && !isPlaceholderData && userId
                ? setTimeout(() => {
                      // A sign-out cleared the store while this write waited; writing now would put the list back.
                      if (generation !== getThreadListClearGeneration() || clearedElsewhere.current || userIdOf(client.getAuthToken()) !== userId) {
                          return;
                      }

                      writeThreadListCache(userId, data);
                  }, WRITE_DEBOUNCE_MS)
                : undefined;

        return () => {
            clearTimeout(timer);
        };
    }, [client, data, isPlaceholderData, userId]);
};
