import { tokenRefreshDelayMs } from "@neore/client-runtime";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { clearLastThread } from "../chat/last-thread-store";
import { sendSessions } from "../chat/send-sessions";
import { loadConfig } from "../lib/config";
import { getClient } from "../lib/lunora";
import {
    backendPushServer,
    devicePushPlatform,
    dismissAccountNotifications,
    pushRegistrations,
} from "../notifications/phone-push";
import { releaseOnSignOut } from "../notifications/push-registration";
import { endPhonePushForAccount } from "../notifications/use-phone-push";
import { getOfflineCache } from "../offline/database";
import { AuthContext } from "./auth-state";
import { fetchAccessToken, readStoredUser, revokeSessionToken, takeStoredGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { createAuthEpoch, INITIAL_SESSION, reduceSession } from "./session-state";
import { signInWithBrowser } from "./sign-in";
import { emptyCacheWhileSignedOut, runSignOut, signOutOnDevice } from "./sign-out";

/** Re-mint the JWT this long before the client's own refresh point, if `exp` is unknown. */
const FALLBACK_REFRESH_MS = 60_000;

/** How long to wait before re-minting after the token route failed without answering "no session". */
const TOKEN_RETRY_MS = 15_000;

const nextTick = (tick: number): number => tick + 1;

/**
 * Keeps the Lunora client's bearer in step with the stored grant. The JWT lives in
 * memory only; it is re-minted when client-runtime says the current one is due.
 * A returning person is signed in from the stored user before the first mint answers
 * (`reduceSession`), so the app opens on their saved chats instead of waiting on the network.
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [session, dispatch] = useReducer(reduceSession, INITIAL_SESSION);
    const { hasToken, isConfirming, status, user } = session;
    const [refreshTick, setRefreshTick] = useState(0);
    // Bumped by every sign-in and sign-out: a mint still out from before applies nothing.
    const [epoch] = useState(createAuthEpoch);

    // Signed in again: sends begin again (a sign-out closed them, `sendSessions`).
    useEffect(() => {
        if (status !== "signed-in") {
            return;
        }

        sendSessions.open();
    }, [status]);
    // Callers of `retryToken` waiting for the attempt they asked for to end.
    const renewalWaiters = useRef<(() => void)[]>([]);
    const [config] = useState(loadConfig);
    const [client] = useState(getClient);

    // The stored user is on the device: reading it needs no network, so it paints the signed-in app at once. A sign-out,
    // a mint or a sign-in that starts first wins (the reducer ignores a late read).
    useEffect(() => {
        let isCancelled = false;

        const paint = async () => {
            const storedUser = await readStoredUser(secureGrantStore);

            if (!isCancelled) {
                dispatch({ type: "stored-user", user: storedUser });
            }
        };

        paint();

        return () => {
            isCancelled = true;
        };
    }, []);

    useEffect(() => {
        let isCancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hasEpochEnded = epoch.start();
        const isStale = () => isCancelled || hasEpochEnded();

        const mint = async () => {
            let jwt: string | null;

            try {
                jwt = await fetchAccessToken({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });
            } catch {
                // The grant is still stored: try again. Meanwhile a person who is known on this device is signed in, so
                // that a launch with no connection opens on the saved chats instead of waiting for a token it cannot get.
                const storedUser = await readStoredUser(secureGrantStore);

                if (!isStale()) {
                    dispatch({ type: "unreachable", user: storedUser });
                    timer = setTimeout(setRefreshTick, TOKEN_RETRY_MS, nextTick);
                }

                return;
            }

            if (isStale()) {
                return;
            }

            client.setAuthToken(jwt);

            if (jwt === null) {
                dispatch({ type: "signed-out" });
                sendSessions.signOut();
                // Retries a cache wipe that failed at sign-out; the credential side never waits on it.
                await emptyCacheWhileSignedOut({
                    clearCache: () => getOfflineCache().clear(),
                    forgetLastChat: clearLastThread,
                    warn: console.warn,
                });

                return;
            }

            const storedUser = await readStoredUser(secureGrantStore);

            if (isStale()) {
                return;
            }

            dispatch({ type: "token", user: storedUser });
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
    }, [client, config.lunoraUrl, epoch, refreshTick]);

    const signIn = useCallback(async () => {
        // Ends every mint out, and reopens the epoch a sign-out closed.
        epoch.open();
        dispatch({ type: "sign-in-started" });

        try {
            await signInWithBrowser({ appUrl: config.appUrl, lunoraUrl: config.lunoraUrl });
        } finally {
            // Also after a cancelled browser flow: the mint it ended must be replaced, or the status stays `loading`.
            setRefreshTick(nextTick);
        }
    }, [config.appUrl, config.lunoraUrl, epoch]);

    const signOut = useCallback(async () => {
        // From here on, no prompt and no registration for the account that is leaving.
        endPhonePushForAccount();
        // Its sends still going stop (no retry saves a message for it, and none gives its prompt back), and stay closed for
        // the whole sign-out, so a send begun during the teardown (the account still reads as signed in) is stopped too;
        // the next sign-in opens them.
        sendSessions.signOut();

        // A mint still out when sign-out starts applies nothing: the epoch ends before the first await (`runSignOut`).
        await runSignOut({
            // Closed until the next sign-in: a mint a refresh timer begins during the teardown applies nothing either.
            endMints: () => epoch.close(),
            finish: () => {
                client.setAuthToken(null);
                dispatch({ type: "signed-out" });
            },
            // The cache holds this person's chats: it is emptied FIRST and locally, so a sign-out request that fails or
            // hangs offline cannot leave them behind. Then the stored grant is cleared, so nothing on the phone can sign in
            // with it, and only then is the server told.
            teardown: async () =>
                await signOutOnDevice({
                    clearCache: () => getOfflineCache().clear(),
                    dismissNotifications: dismissAccountNotifications,
                    forgetLastChat: clearLastThread,
                    releasePush: async () =>
                        await releaseOnSignOut({ platform: devicePushPlatform, registrations: pushRegistrations, server: backendPushServer(client) }),
                    revokeSession: async (token) => await revokeSessionToken({ fetch, lunoraUrl: config.lunoraUrl, token }),
                    takeCredential: async () => await takeStoredGrant(secureGrantStore),
                    // eslint-disable-next-line no-console -- no logger in the app; a failed clear must not be silent
                    warn: console.warn,
                }),
        });
    }, [client, config.lunoraUrl, epoch]);

    const retryToken = useCallback(
        () =>
            new Promise<void>((resolve) => {
                renewalWaiters.current.push(resolve);
                setRefreshTick(nextTick);
            }),
        [],
    );

    const value = useMemo(() => {
        return { hasToken, isConfirming, retryToken, signIn, signOut, status, user };
    }, [hasToken, isConfirming, retryToken, signIn, signOut, status, user]);

    return <AuthContext value={value}>{children}</AuthContext>;
};
