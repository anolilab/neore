import { tokenRefreshDelayMs } from "@neore/client-runtime";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { loadConfig } from "../lib/config";
import { getClient } from "../lib/lunora";
import type { GrantUser } from "./grant";
import { fetchAccessToken, signOutGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { signInWithBrowser } from "./sign-in";

export type AuthStatus = "loading" | "signed-in" | "signed-out";

interface AuthValue {
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
    status: AuthStatus;
    user: GrantUser | null;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Re-mint the JWT this long before the client's own refresh point, if `exp` is unknown. */
const FALLBACK_REFRESH_MS = 60_000;

/** How long to wait before re-minting after the token route failed without answering "no session". */
const TOKEN_RETRY_MS = 15_000;

/**
 * Keeps the Lunora client's bearer in step with the stored grant. The JWT lives in
 * memory only; it is re-minted when client-runtime says the current one is due.
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [status, setStatus] = useState<AuthStatus>("loading");
    const [user, setUser] = useState<GrantUser | null>(null);
    const [refreshTick, setRefreshTick] = useState(0);
    const signOutCount = useRef(0);
    const config = useMemo(() => loadConfig(), []);
    const client = useMemo(() => getClient(), []);

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
                    timer = setTimeout(() => setRefreshTick((tick) => tick + 1), TOKEN_RETRY_MS);
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

            const stored = await secureGrantStore.get();

            if (isStale()) {
                return;
            }

            setUser(stored?.user ?? null);
            setStatus("signed-in");
            timer = setTimeout(() => setRefreshTick((tick) => tick + 1), tokenRefreshDelayMs(jwt) ?? FALLBACK_REFRESH_MS);
        };

        void run();

        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [client, config.lunoraUrl, refreshTick]);

    const signIn = useCallback(async () => {
        await signInWithBrowser({ appUrl: config.appUrl, lunoraUrl: config.lunoraUrl });
        setRefreshTick((tick) => tick + 1);
    }, [config.appUrl, config.lunoraUrl]);

    const signOut = useCallback(async () => {
        await signOutGrant({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });
        signOutCount.current += 1;
        client.setAuthToken(null);
        setUser(null);
        setStatus("signed-out");
    }, [client, config.lunoraUrl]);

    const value = useMemo(() => { return { signIn, signOut, status, user }; }, [signIn, signOut, status, user]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthValue => {
    const value = useContext(AuthContext);

    if (!value) {
        throw new Error("useAuth must be used inside AuthProvider");
    }

    return value;
};
