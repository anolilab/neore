import { useEffect, useState } from "react";

import { clearAccessToken } from "./access-token";
import type { GrantUser, StoredGrant } from "./extension-grant";
import { grantKey, readGrant, signOutGrant, STORAGE_KEY } from "./extension-grant";

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

/** Forget this panel's bearer first, then end the grant. */
export const signOut = async (): Promise<void> => {
    clearAccessToken();
    await signOutGrant();
};

/** The stored grant's session, kept in step with `storage.local`. `undefined` while loading. */
const useGrantSession = (): { isPending: boolean; session: GrantSession | null } => {
    const [session, setSession] = useState<GrantSession | null | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && Object.hasOwn(changes, STORAGE_KEY)) {
                setSession(toGrantSession(changes[STORAGE_KEY]?.newValue as StoredGrant | undefined));
            }
        };

        chrome.storage.onChanged.addListener(listener);

        const load = async () => {
            const loaded = await loadGrantSession();

            if (!cancelled) {
                // A change that arrived first is newer than this read.
                setSession((current) => (current === undefined ? loaded : current));
            }
        };

        void load();

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
