import type { LunoraClient } from "@lunora/client";
import { tokenSubject } from "@neore/client-runtime";

import { tokenExpiresAt } from "./access-token";

/** Never refresh more often than this, whatever `exp` says. */
export const MIN_REFRESH_DELAY_MS = 30_000;

/**
 * Keeps `client`'s bearer in step with the stored grant until the returned stop
 * is called.
 *
 * `setAuthToken` takes a token, not a fetcher, so this also schedules the
 * refresh: the JWT is short-lived, and without one every query would go
 * anonymous a few minutes after sign-in.
 *
 * Each token goes in with the grant's user id as its subject. Without one,
 * Lunora reads a refreshed JWT as another identity and discards the writes
 * queued offline under the old one. The subject is asserted only for a token
 * whose `sub` is that user: `getAccessToken` answers with the grant stored when
 * it returns, so a sign-in from another panel can hand this loop another
 * account's token before the effect that started it is torn down, and that one
 * must read as the switch it is.
 *
 * A refresh that gets no token (offline, or the server unreachable) keeps the
 * bearer it holds and tries again. Clearing it would read as a sign-out and drop
 * the queue. A grant that is really gone ends the session, and with it this loop.
 *
 * The stop leaves the bearer installed: whether it goes is the next session's
 * call (`createAuthTokenSync`).
 */
export const keepAuthToken = (
    client: Pick<LunoraClient, "setAuthToken">,
    userId: string,
    getToken: (options: { force: boolean }) => Promise<string | null>,
): (() => void) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (force: boolean) => {
        const token = await getToken({ force });

        if (stopped) {
            return;
        }

        if (token === null) {
            timer = setTimeout(() => {
                void refresh(true);
            }, MIN_REFRESH_DELAY_MS);

            return;
        }

        if (tokenSubject(token) === userId) {
            client.setAuthToken(token, userId);
        } else {
            client.setAuthToken(token);
        }

        const expiresAt = tokenExpiresAt(token);

        if (expiresAt !== undefined) {
            timer = setTimeout(
                () => {
                    void refresh(true);
                },
                Math.max(MIN_REFRESH_DELAY_MS, expiresAt - Date.now() - 60_000),
            );
        }
    };

    void refresh(false);

    return () => {
        stopped = true;
        clearTimeout(timer);
    };
};

/**
 * Moves `client`'s bearer from one grant to the next. Every sign-in stores a new
 * grant, even for the account already signed in, so the loop restarts on each;
 * only a sign-out or another account clears the bearer. Clearing it reads as a
 * sign-out to Lunora, which drops the writes queued offline: for the same user
 * the old bearer stays until the new grant's arrives. Another account's queries
 * must not leave with this one's, so a switch clears it before the new loop
 * starts.
 *
 * `signOut` also stops the running loop: a sign-out clears the bearer before
 * the grant is gone from storage, and may fail to remove it, so the session
 * that started the loop can outlive the click.
 */
export const createAuthTokenSync = (
    client: Pick<LunoraClient, "setAuthToken">,
    getToken: (options: { force: boolean }) => Promise<string | null>,
): { signOut: () => void; start: (userId: string) => () => void } => {
    let lastUserId: string | undefined;
    let stopRunning: (() => void) | undefined;

    return {
        signOut: () => {
            stopRunning?.();
            stopRunning = undefined;
            lastUserId = undefined;
            client.setAuthToken(null);
        },
        start: (userId) => {
            if (lastUserId !== undefined && lastUserId !== userId) {
                client.setAuthToken(null);
            }

            lastUserId = userId;

            const stop = keepAuthToken(client, userId, getToken);

            stopRunning = stop;

            return () => {
                stop();

                if (stopRunning === stop) {
                    stopRunning = undefined;
                }
            };
        },
    };
};
