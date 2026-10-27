import { tokenRefreshDelayMs } from "@neore/client-runtime";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadConfig } from "../lib/config";
import { getClient } from "../lib/lunora";
import type { AuthStatus } from "./auth-state";
import { AuthContext } from "./auth-state";
import type { GrantUser } from "./grant";
import { fetchAccessToken, readStoredUser, signOutGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { signInWithBrowser } from "./sign-in";

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
                // The grant is still stored: keep the current state and try again.
                if (!isStale()) {
                    timer = setTimeout(setRefreshTick, TOKEN_RETRY_MS, nextTick);
                }

                return;
            }

            if (isStale()) {
                return;
            }

            client.setAuthToken(jwt);

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
            await signOutGrant({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });
        } catch (error) {
            // The stored grant could not be cleared. The user is still signed out in memory below.
            // eslint-disable-next-line no-console -- no logger in the app; a failed clear must not be silent
            console.warn("Could not clear the stored sign-in.", error);
        } finally {
            signOutCount.current += 1;
            client.setAuthToken(null);
            setUser(null);
            setStatus("signed-out");
        }
    }, [client, config.lunoraUrl]);

    const value = useMemo(() => {
        return { signIn, signOut, status, user };
    }, [signIn, signOut, status, user]);

    return <AuthContext value={value}>{children}</AuthContext>;
};
