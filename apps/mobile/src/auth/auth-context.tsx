import { tokenRefreshDelayMs } from "@neore/client-runtime";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadConfig } from "../lib/config";
import { getClient } from "../lib/lunora";
import { getOfflineCache } from "../offline/database";
import type { AuthStatus } from "./auth-state";
import { AuthContext } from "./auth-state";
import type { GrantUser } from "./grant";
import { fetchAccessToken, readStoredUser, signOutGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { signInWithBrowser } from "./sign-in";
import { signOutOnDevice } from "./sign-out";

/** Re-mint the JWT this long before the client's own refresh point, if `exp` is unknown. */
const FALLBACK_REFRESH_MS = 60_000;

/** How long to wait before re-minting after the token route failed without answering "no session". */
const TOKEN_RETRY_MS = 15_000;

const nextTick = (tick: number): number => tick + 1;

/**
 * Keeps the Lunora client's bearer in step with the stored grant. The JWT lives in
 * memory only; it is re-minted when client-runtime says the current one is due.
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [status, setStatus] = useState<AuthStatus>("loading");
    const [user, setUser] = useState<GrantUser | null>(null);
    const [refreshTick, setRefreshTick] = useState(0);
    const [hasToken, setHasToken] = useState(false);
    const signOutCount = useRef(0);
    const [config] = useState(loadConfig);
    const [client] = useState(getClient);

    useEffect(() => {
        let isCancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const signOutsAtStart = signOutCount.current;
        const isStale = () => isCancelled || signOutsAtStart !== signOutCount.current;

        const run = async () => {
            let jwt: string | null;

            try {
                jwt = await fetchAccessToken({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });
            } catch {
                // The grant is still stored: try again. Meanwhile a person who is known on this device is signed in, so
                // that a launch with no connection opens on the saved chats instead of waiting for a token it cannot get.
                const storedUser = await readStoredUser(secureGrantStore);

                if (!isStale()) {
                    if (storedUser !== null) {
                        setUser(storedUser);
                        setStatus("signed-in");
                    }

                    timer = setTimeout(setRefreshTick, TOKEN_RETRY_MS, nextTick);
                }

                return;
            }

            if (isStale()) {
                return;
            }

            client.setAuthToken(jwt);
            setHasToken(jwt !== null);

            if (jwt === null) {
                setUser(null);
                setStatus("signed-out");

                return;
            }

            const storedUser = await readStoredUser(secureGrantStore);

            if (isStale()) {
                return;
            }

            setUser(storedUser);
            setStatus("signed-in");
            timer = setTimeout(setRefreshTick, tokenRefreshDelayMs(jwt) ?? FALLBACK_REFRESH_MS, nextTick);
        };

        run();

        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [client, config.lunoraUrl, refreshTick]);

    const signIn = useCallback(async () => {
        await signInWithBrowser({ appUrl: config.appUrl, lunoraUrl: config.lunoraUrl });
        setRefreshTick(nextTick);
    }, [config.appUrl, config.lunoraUrl]);

    const signOut = useCallback(async () => {
        try {
            // The cache holds this person's chats: it is emptied FIRST and locally, so a sign-out request that fails or
            // hangs offline cannot leave them behind. Then the server is told and the stored grant cleared.
            await signOutOnDevice({
                clearCache: () => getOfflineCache().clear(),
                revokeGrant: () => signOutGrant({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore }),
                // eslint-disable-next-line no-console -- no logger in the app; a failed clear must not be silent
                warn: console.warn,
            });
        } finally {
            signOutCount.current += 1;
            client.setAuthToken(null);
            setHasToken(false);
            setUser(null);
            setStatus("signed-out");
        }
    }, [client, config.lunoraUrl]);

    const retryToken = useCallback(() => setRefreshTick(nextTick), []);

    const value = useMemo(() => {
        return { hasToken, retryToken, signIn, signOut, status, user };
    }, [hasToken, retryToken, signIn, signOut, status, user]);

    return <AuthContext value={value}>{children}</AuthContext>;
};
