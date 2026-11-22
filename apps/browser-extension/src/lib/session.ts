import { useSyncExternalStore } from "react";

import { holdAccessTokens, releaseAccessTokens } from "./access-token";
import type { SuspendedSession } from "./auth-token-sync";
import type { GrantUser, StoredGrant } from "./extension-grant";
import { finishPendingSignOut, grantKey, readGrant, SIGNED_OUT_KEY, signOutGrant, STORAGE_KEY } from "./extension-grant";
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

/**
 * The stored grant's session, or `null` when there is none — and when storage
 * cannot be read: the panel then offers sign-in, which writes a new grant,
 * rather than waiting on a read that will not come.
 */
export const loadGrantSession = async (): Promise<GrantSession | null> => {
    try {
        return toGrantSession(await readGrant());
    } catch {
        return null;
    }
};

/** The sign-out running for each grant key: a second one for the same grant joins it. */
const signingOut = new Map<string, Promise<void>>();

/**
 * Set when a sign-out ends with its grant marked but still stored
 * (`GrantRemovalError`). The mark unmounts Settings, whose own alert goes with
 * it, so the sign-in page reads this instead.
 */
let signOutUnfinished = false;
const unfinishedWatchers = new Set<() => void>();

const setSignOutUnfinished = (next: boolean): void => {
    if (signOutUnfinished === next) {
        return;
    }

    signOutUnfinished = next;

    for (const watcher of unfinishedWatchers) {
        watcher();
    }
};

/** Hide the notice of an unfinished sign-out (`useSignOutUnfinished`): a new sign-in is starting. */
export const dismissSignOutUnfinished = (): void => {
    setSignOutUnfinished(false);
};

/** Whether this panel's last sign-out left its grant stored (marked, never used again). */
export const useSignOutUnfinished = (): boolean =>
    useSyncExternalStore(
        (onChange) => {
            unfinishedWatchers.add(onChange);

            return () => {
                unfinishedWatchers.delete(onChange);
            };
        },
        () => signOutUnfinished,
    );

const runEndSession = async (authTokenSync: { suspend: () => SuspendedSession }, key: string): Promise<void> => {
    holdAccessTokens();
    setSignOutUnfinished(false);

    const suspended = authTokenSync.suspend();
    let outcome: "replaced" | "signed-out";

    try {
        outcome = await signOutGrant(key);
    } catch (error) {
        // The grant was marked signed out before its removal failed: it is never
        // used again, whether or not the server confirmed the revoke.
        if (error instanceof GrantRemovalError) {
            suspended.finish();
            setSignOutUnfinished(true);
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
const sessionWatchers = new Set<() => void>();
let stopWatching: (() => void) | undefined;

const publish = (next: GrantSession | null): void => {
    shown = next;

    for (const watcher of sessionWatchers) {
        watcher();
    }
};

/**
 * Follow the stored grant in `storage.local`. A grant marked signed out
 * (`SIGNED_OUT_KEY`) reads as none, so each change to either key is read
 * again; the latest read wins. A first read that fails offers sign-in
 * (`loadGrantSession`); a later one keeps what is shown, since publishing none
 * would sign the provider out and drop the writes queued offline.
 */
const watchGrantSession = (): (() => void) => {
    let stopped = false;
    let reads = 0;

    const load = async () => {
        reads += 1;

        const read = reads;
        let loaded: GrantSession | null;

        try {
            loaded = toGrantSession(await readGrant());
        } catch {
            if (shown !== undefined) {
                return;
            }

            loaded = null;
        }

        if (!stopped && read === reads) {
            publish(loaded);
        }
    };

    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "local" && (Object.hasOwn(changes, STORAGE_KEY) || Object.hasOwn(changes, SIGNED_OUT_KEY))) {
            void load();
        }
    };

    chrome.storage.onChanged.addListener(listener);
    void load();
    // A sign-out whose removal failed in an earlier panel: remove its leftover grant, once per watch.
    void finishPendingSignOut().catch(() => undefined);

    return () => {
        stopped = true;
        shown = undefined;
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
