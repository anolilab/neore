import { useEffect, useState } from "react";

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

const runEndSession = async (authTokenSync: { suspend: () => SuspendedSession }, key: string): Promise<void> => {
    holdAccessTokens();

    const suspended = authTokenSync.suspend();
    let outcome: "replaced" | "signed-out";

    try {
        outcome = await signOutGrant(key);
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
 * (`holdAccessTokens`) and the refresh loop stops; the bearer and the writes
 * queued offline under it stay. Once the grant is gone the bearer is cleared.
 *
 * When storage fails to read the grant or to mark it signed out, nothing
 * changed: this rejects and the session comes back for it (its tokens flow and
 * the loop restarts, the queue intact). Once marked, the grant is never used
 * again: when only its removal fails this still rejects so the caller can show
 * it, but the bearer is cleared, tokens stay held, and the next panel to load
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

/**
 * The stored grant's session, kept in step with `storage.local`. `undefined`
 * while loading. A grant marked signed out (`SIGNED_OUT_KEY`) reads as none, so
 * each change to either key is read again; the latest read wins.
 */
const useGrantSession = (): { isPending: boolean; session: GrantSession | null } => {
    const [session, setSession] = useState<GrantSession | null | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;
        let reads = 0;

        const load = async () => {
            reads += 1;

            const read = reads;
            const loaded = await loadGrantSession();

            if (!cancelled && read === reads) {
                setSession(loaded);
            }
        };

        const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && (Object.hasOwn(changes, STORAGE_KEY) || Object.hasOwn(changes, SIGNED_OUT_KEY))) {
                void load();
            }
        };

        chrome.storage.onChanged.addListener(listener);
        void load();
        // A sign-out whose removal failed in an earlier panel: remove its leftover grant now.
        void finishPendingSignOut().catch(() => undefined);

        return () => {
            cancelled = true;
            chrome.storage.onChanged.removeListener(listener);
        };
    }, []);

    return { isPending: session === undefined, session: session ?? null };
};

export const useSession = (): { data: ExtensionSession | null; isPending: boolean } => {
    const { isPending, session } = useGrantSession();

    return { data: session ? { sessionId: session.key, user: session.user } : null, isPending };
};
