import { useSyncExternalStore } from "react";

import { holdAccessTokens, releaseAccessTokens } from "./access-token";
import type { SuspendedSession } from "./auth-token-sync";
import type { GrantUser, StoredGrant } from "./extension-grant";
import { finishPendingSignOut, grantKey, readGrantState, SIGN_OUT_FAILED_KEY, SIGNED_OUT_KEY, signOutGrant, STORAGE_KEY } from "./extension-grant";
import { GrantReadError } from "./grant-read-error";
import { GrantRemovalError } from "./grant-removal-error";

/**
 * The signed-in user: the app grant this extension holds itself
 * (`extension-grant.ts`). Neither build reads the web app's cookie session.
 */
export interface ExtensionSession {
    /** Changes when the signed-in session does; for effect dependencies, not display. */
    sessionId: string;
    user: { email: string; id: string; image?: string | null; name?: string | null };
}

interface GrantSession {
    key: string;
    user: GrantUser;
}

const toGrantSession = (grant: StoredGrant | undefined): GrantSession | null => (grant ? { key: grantKey(grant), user: grant.user } : null);

/** The sign-out running for each grant key: a second one for the same grant joins it. */
const signingOut = new Map<string, Promise<void>>();

/**
 * Removals of a marked grant running in this panel (a sign-out, or the retry
 * `finishPendingSignOut` makes): a failure an earlier one stored is not shown
 * while this panel tries again.
 */
let removing = 0;

/**
 * The grant a removal in this panel failed to remove: the sign-in page warns
 * from it while that grant stays stored, even when storage also refused the
 * failure mark (`SIGN_OUT_FAILED_KEY`) other panels read.
 */
let failedHere: string | undefined;
/** Reads storage again for the session watch, when one runs. */
let reloadGrantSession: (() => void) | undefined;

const trackRemoval = async <T>(removal: () => Promise<T>): Promise<T> => {
    removing += 1;

    try {
        return await removal();
    } catch (error) {
        if (error instanceof GrantRemovalError) {
            failedHere = error.key;
        }

        throw error;
    } finally {
        removing -= 1;
        // A fresh read decides: the removal may have succeeded, or failed and left the grant.
        reloadGrantSession?.();
    }
};

const runEndSession = async (authTokenSync: { suspend: () => SuspendedSession }, key: string): Promise<void> => {
    holdAccessTokens();

    const suspended = authTokenSync.suspend();
    let outcome: "replaced" | "signed-out";

    try {
        outcome = await trackRemoval(async () => await signOutGrant(key));
    } catch (error) {
        // The grant was marked signed out before its removal failed: it is never
        // used again, whether or not the server confirmed the revoke.
        if (error instanceof GrantRemovalError) {
            suspended.finish();
        } else {
            releaseAccessTokens();
            suspended.restore();
        }

        throw error;
    }

    if (outcome === "replaced") {
        releaseAccessTokens();
        suspended.restore();

        return;
    }

    suspended.finish();
};

/**
 * End the grant `key` names (the session shown), and this panel's session with
 * it. While the grant is being revoked and removed, no new token goes out
 * (`holdAccessTokens`) and the refresh loop stops. The bearer and the writes
 * queued offline under it stay until the grant is marked signed out: the mark
 * hides the grant, so the panel's session ends there.
 *
 * When storage fails to read the grant or to mark it signed out, nothing
 * changed: this rejects and the session comes back for it (its tokens flow and
 * the loop restarts, the queue intact). Once marked, the grant is never used
 * again: when only its removal fails this still rejects, the sign-in page says
 * so (`useSignOutUnfinished`), tokens stay held, and the next panel to load
 * removes the leftover (`finishPendingSignOut`). When another grant is stored
 * by now, it is left signed in and this resolves.
 *
 * One sign-out per grant: a second call for the same key, from a reopened
 * Settings, joins the one running.
 */
export const endSession = async (authTokenSync: { suspend: () => SuspendedSession }, key: string): Promise<void> => {
    const running = signingOut.get(key);

    if (running) {
        return await running;
    }

    const run = runEndSession(authTokenSync, key).finally(() => {
        signingOut.delete(key);
    });

    signingOut.set(key, run);

    return await run;
};

/** What every `useSession` in this panel shows: `undefined` until the first read. */
let shown: GrantSession | null | undefined;
/** Whether that read found a grant whose removal failed (`SIGN_OUT_FAILED_KEY`), with no removal of it running here. */
let unfinished = false;
const sessionWatchers = new Set<() => void>();
let stopWatching: (() => void) | undefined;

const publish = (next: GrantSession | null, removalFailed: boolean, markedKey: string | undefined): void => {
    // A removal that succeeded, or a sign-in that replaced the grant, ends this panel's own failure.
    if (failedHere !== markedKey) {
        failedHere = undefined;
    }

    shown = next;
    unfinished = (removalFailed || failedHere !== undefined) && removing === 0;

    for (const watcher of sessionWatchers) {
        watcher();
    }
};

/**
 * How long the session watch waits before reading again after a failed read,
 * doubling per failure up to `READ_RETRY_MAX_MS`. It keeps trying while the
 * watch runs: a sign-out another panel marks during the outage fires no new
 * change once storage recovers.
 */
const READ_RETRY_FIRST_MS = 250;
const READ_RETRY_MAX_MS = 30_000;

/**
 * Follow the stored grant in `storage.local`. A grant marked signed out
 * (`SIGNED_OUT_KEY`) reads as none, so each change to either key is read
 * again; the latest read wins. A first read that fails offers sign-in, which
 * writes a new grant; a later one keeps what is shown, since publishing none
 * would sign the provider out and drop the writes queued offline. Either way a
 * failed latest read is tried again until one succeeds (`READ_RETRY_FIRST_MS`):
 * it may have missed a change, and that read publishes it.
 */
const watchGrantSession = (): (() => void) => {
    let stopped = false;
    let reads = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    /**
     * The leftover cleanup: `pending` until one ran past its storage read, never two at once;
     * `waiting` out its backoff after a failed read, whatever reads succeed meanwhile.
     */
    let cleanup: "done" | "pending" | "running" | "waiting" = "pending";
    let cleanupFailures = 0;
    let cleanupRetry: ReturnType<typeof setTimeout> | undefined;

    // A sign-out whose removal failed in an earlier panel: remove its leftover grant, once per watch.
    // A storage read that fails first retries it on the first good read after a backoff like the
    // watch's; any other failure leaves it stored, and the sign-in page says so (`useSignOutUnfinished`).
    const finishLeftover = () => {
        if (cleanup !== "pending") {
            return;
        }

        cleanup = "running";
        void trackRemoval(async () => {
            try {
                await finishPendingSignOut();
                cleanup = "done";
            } catch (error) {
                if (!(error instanceof GrantReadError)) {
                    cleanup = "done";

                    return;
                }

                cleanup = "waiting";
                cleanupRetry = setTimeout(
                    () => {
                        cleanup = "pending";
                        void load();
                    },
                    Math.min(READ_RETRY_FIRST_MS * 2 ** cleanupFailures, READ_RETRY_MAX_MS),
                );
                cleanupFailures += 1;
            }
        });
    };

    const load = async (attempt = 0) => {
        clearTimeout(retry);
        reads += 1;

        const read = reads;
        let loaded: GrantSession | null;
        let failed = false;
        let markedKey = failedHere;

        try {
            const state = await readGrantState();

            loaded = toGrantSession(state.grant);
            failed = state.removalFailed;
            markedKey = state.markedKey;

            if (!stopped) {
                finishLeftover();
            }
        } catch {
            if (stopped || read !== reads) {
                return;
            }

            retry = setTimeout(
                () => {
                    void load(attempt + 1);
                },
                Math.min(READ_RETRY_FIRST_MS * 2 ** attempt, READ_RETRY_MAX_MS),
            );

            if (shown !== undefined) {
                return;
            }

            loaded = null;
        }

        if (!stopped && read === reads) {
            publish(loaded, failed, markedKey);
        }
    };

    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "local" && [STORAGE_KEY, SIGNED_OUT_KEY, SIGN_OUT_FAILED_KEY].some((key) => Object.hasOwn(changes, key))) {
            void load();
        }
    };

    chrome.storage.onChanged.addListener(listener);
    reloadGrantSession = () => {
        void load();
    };
    void load();
    finishLeftover();

    return () => {
        stopped = true;
        clearTimeout(retry);
        clearTimeout(cleanupRetry);
        shown = undefined;
        unfinished = false;
        reloadGrantSession = undefined;
        chrome.storage.onChanged.removeListener(listener);
    };
};

/** One storage watch per panel, however many components read the session. */
const subscribeGrantSession = (onChange: () => void): (() => void) => {
    sessionWatchers.add(onChange);
    stopWatching ??= watchGrantSession();

    return () => {
        sessionWatchers.delete(onChange);

        if (sessionWatchers.size === 0) {
            stopWatching?.();
            stopWatching = undefined;
        }
    };
};

const useGrantSession = (): { isPending: boolean; session: GrantSession | null } => {
    const session = useSyncExternalStore(subscribeGrantSession, () => shown);

    return { isPending: session === undefined, session: session ?? null };
};

export const useSession = (): { data: ExtensionSession | null; isPending: boolean } => {
    const { isPending, session } = useGrantSession();

    return { data: session ? { sessionId: session.key, user: session.user } : null, isPending };
};

/**
 * Whether a sign-out failed to remove its grant (marked, never used again), in
 * this panel or any other: read from storage through the shared watch, so every
 * panel shows it (this panel's own failure shows even when its mark was never
 * written: `failedHere`), and it clears once a removal succeeds or a sign-in replaces
 * the grant. Not while a sign-out is still running, here or in another panel,
 * nor while this panel tries the removal again.
 */
export const useSignOutUnfinished = (): boolean => useSyncExternalStore(subscribeGrantSession, () => unfinished);
