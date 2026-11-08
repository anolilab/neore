import { tokenRefreshDelayMs } from "@neore/client-runtime";
import { dismissAllNotificationsAsync } from "expo-notifications";
import { deleteItemAsync } from "expo-secure-store";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clearLastThread } from "../chat/last-thread-store";
import { loadConfig } from "../lib/config";
import { getClient } from "../lib/lunora";
import { clearTapRoute } from "../notifications/pending-tap";
import { backendPushServer, devicePushPlatform, pushRegistrations } from "../notifications/phone-push";
import { forgetAccountOnPhone, releasePhonePush } from "../notifications/push-registration";
import { getOfflineCache } from "../offline/database";
import type { AuthStatus } from "./auth-state";
import { AuthContext } from "./auth-state";
import type { GrantUser } from "./grant";
import { fetchAccessToken, readStoredUser, revokeSessionToken, takeStoredGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { signInWithBrowser } from "./sign-in";
import { emptyCacheWhileSignedOut, signOutOnDevice } from "./sign-out";

/** Re-mint the JWT this long before the client's own refresh point, if `exp` is unknown. */
const FALLBACK_REFRESH_MS = 60_000;

/** How long to wait before re-minting after the token route failed without answering "no session". */
const TOKEN_RETRY_MS = 15_000;

const nextTick = (tick: number): number => tick + 1;

/**
 * The alerts on the phone, and a chat held from a tap, belong to the account that is leaving: neither stays. The
 * record of that account goes last: if the alerts could not be removed, the next sign-in still sees the switch.
 */
const dismissPreviousAccountAlerts = async (): Promise<void> => {
    clearTapRoute();
    await dismissAllNotificationsAsync();
    await forgetAccountOnPhone({ remove: deleteItemAsync });
};

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
    // Callers of `retryToken` waiting for the attempt they asked for to end.
    const renewalWaiters = useRef<(() => void)[]>([]);
    const [config] = useState(loadConfig);
    const [client] = useState(getClient);

    useEffect(() => {
        let isCancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const signOutsAtStart = signOutCount.current;
        const isStale = () => isCancelled || signOutsAtStart !== signOutCount.current;

        const mint = async () => {
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
                // Retries a cache wipe that failed at sign-out; the credential side never waits on it.
                await emptyCacheWhileSignedOut({
                    clearCache: () => getOfflineCache().clear(),
                    dismissNotifications: dismissPreviousAccountAlerts,
                    forgetLastChat: clearLastThread,
                    warn: console.warn,
                });

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

        const run = async () => {
            try {
                await mint();
            } finally {
                const waiting = [...renewalWaiters.current];

                renewalWaiters.current.length = 0;

                for (const resolve of waiting) {
                    resolve();
                }
            }
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
                dismissNotifications: dismissPreviousAccountAlerts,
                forgetLastChat: clearLastThread,
                releasePush: async () => {
                    // No registration may send the token from here on; one already on its way finishes first, so it
                    // cannot land after the release and give the phone back to this account.
                    const isSigningOut = pushRegistrations.close();

                    await pushRegistrations.settle();
                    await releasePhonePush({ isCurrent: isSigningOut, platform: devicePushPlatform, server: backendPushServer(client) });
                },
                revokeSession: async (token) => await revokeSessionToken({ fetch, lunoraUrl: config.lunoraUrl, token }),
                takeCredential: async () => await takeStoredGrant(secureGrantStore),
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

    const retryToken = useCallback(
        () =>
            new Promise<void>((resolve) => {
                renewalWaiters.current.push(resolve);
                setRefreshTick(nextTick);
            }),
        [],
    );

    const value = useMemo(() => {
        return { hasToken, retryToken, signIn, signOut, status, user };
    }, [hasToken, retryToken, signIn, signOut, status, user]);

    return <AuthContext value={value}>{children}</AuthContext>;
};
