import type { LunoraClient } from "@lunora/client";
import { tokenSubject } from "@neore/client-runtime";

import { tokenExpiresAt } from "./access-token";

/** Never refresh more often than this, whatever `exp` says. */
export const MIN_REFRESH_DELAY_MS = 30_000;

/**
 * Installs `token` under its own `sub`, the user id of the grant it was minted
 * for. Another account's token goes in under that account, so Lunora reads the
 * switch at once: it drops the writes queued under the old subject and the old
 * account's cached reads. Left without one, the old subject would stick to the
 * new token, and Lunora would hold the queue and suppress the cached reads until
 * a session read names the user.
 *
 * A `null` subject means nobody signed in to Lunora, so a token with no `sub`
 * (the backend mints none) is never given one: the bearer is cleared first,
 * which drops the sticky subject, and the token then goes in bare, keyed on its
 * own hash. Returns the subject it installed, `undefined` for a bare token.
 */
const installBearer = (client: Pick<LunoraClient, "setAuthToken">, token: string): string | undefined => {
    const sub = tokenSubject(token);

    if (sub === null || sub === token) {
        client.setAuthToken(null);
        client.setAuthToken(token);

        return undefined;
    }

    client.setAuthToken(token, sub);

    return sub;
};

/**
 * Keeps `client`'s bearer in step with the stored grant until the returned stop
 * is called.
 *
 * `setAuthToken` takes a token, not a fetcher, so this also schedules the
 * refresh: the JWT is short-lived, and without one every query would go
 * anonymous a few minutes after sign-in.
 *
 * Each token goes in with its user id as the subject (`installBearer`). Without
 * one, Lunora reads a refreshed JWT as another identity and discards the writes
 * queued offline under the old one. The id is the token's own, not the grant's
 * the loop started for: `getAccessToken` answers with the grant stored when it
 * returns, so a sign-in from another panel can hand this loop another account's
 * token before the effect that started it is torn down, and that one must read
 * as the switch it is.
 *
 * A refresh that gets no token (offline, or the server unreachable) keeps the
 * bearer it holds and tries again. Clearing it would read as a sign-out and drop
 * the queue. A grant that is really gone ends the session, and with it this loop.
 *
 * The stop leaves the bearer installed: whether it goes is the next session's
 * call (`createAuthTokenSync`). `onInstall` hears the subject of each bearer
 * installed under one.
 */
export const keepAuthToken = (
    client: Pick<LunoraClient, "setAuthToken">,
    getToken: (options: { force: boolean }) => Promise<string | null>,
    onInstall?: (sub: string) => void,
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

        const sub = installBearer(client, token);

        if (sub !== undefined) {
            onInstall?.(sub);
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

/** A sign-out in progress (`createAuthTokenSync().suspend`). */
export interface SuspendedSession {
    /** The grant is gone: clear the bearer, unless another session has started since. */
    finish: () => void;
    /** The grant is still stored: refresh its bearer again, unless another session has started since. */
    restore: () => void;
}

/**
 * Moves `client`'s bearer from one grant to the next. Every sign-in stores a new
 * grant, even for the account already signed in, so the loop restarts on each;
 * only a sign-out or another account clears the bearer. Clearing it reads as a
 * sign-out to Lunora, which drops the writes queued offline: for the same user
 * the old bearer stays until the new grant's arrives. Another account's queries
 * must not leave with this one's, so a switch clears it before the new loop
 * starts.
 *
 * A sign-out first `suspend`s: the loop stops, but the bearer and its offline
 * queue stay until the grant is really gone (`finish`). If storage keeps the
 * grant, `restore` restarts the loop for it. Either is a no-op once another
 * session has started, so a sign-in from another panel is never undone.
 *
 * The account on record is the one whose bearer is installed: a loop handed
 * another account's token (a sign-in from another panel) records that account,
 * so its own `start` that follows keeps the bearer and its queue.
 */
export const createAuthTokenSync = (
    client: Pick<LunoraClient, "setAuthToken">,
    getToken: (options: { force: boolean }) => Promise<string | null>,
): { signOut: () => void; start: (userId: string) => () => void; suspend: () => SuspendedSession } => {
    let lastUserId: string | undefined;
    let stopLoop: (() => void) | undefined;
    /** Bumped by every start and sign-out: what a suspended sign-out checks before it acts. */
    let generation = 0;

    const run = () => {
        stopLoop?.();
        stopLoop = keepAuthToken(client, getToken, (sub) => {
            lastUserId = sub;
        });
    };

    const stop = () => {
        stopLoop?.();
        stopLoop = undefined;
    };

    const signOut = () => {
        generation += 1;
        stop();
        lastUserId = undefined;
        client.setAuthToken(null);
    };

    return {
        signOut,
        start: (userId) => {
            if (lastUserId !== undefined && lastUserId !== userId) {
                client.setAuthToken(null);
            }

            lastUserId = userId;
            generation += 1;

            const started = generation;

            run();

            return () => {
                if (generation === started) {
                    stop();
                }
            };
        },
        suspend: () => {
            const suspended = generation;
            const userId = lastUserId;

            stop();

            return {
                finish: () => {
                    if (generation === suspended) {
                        signOut();
                    }
                },
                restore: () => {
                    if (generation === suspended && userId !== undefined) {
                        run();
                    }
                },
            };
        },
    };
};
