import { useEffect, useState } from "react";

import type { GrantUser, StoredGrant } from "./extension-grant";
import { readGrant, STORAGE_KEY } from "./extension-grant";

export { signOutGrant as signOut } from "./extension-grant";

/**
 * The signed-in user: the app grant this extension holds itself
 * (`extension-grant.ts`). Neither build reads the web app's cookie session.
 */
export interface ExtensionSession {
    /** Changes when the signed-in session does; for effect dependencies, not display. */
    sessionId: string;
    user: { email: string; id: string; image?: string | null; name?: string | null };
}

/** The stored grant's user, kept in step with `storage.local`. `undefined` while loading. */
const useGrantUser = (): { isPending: boolean; user: GrantUser | null } => {
    const [user, setUser] = useState<GrantUser | null | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && Object.hasOwn(changes, STORAGE_KEY)) {
                setUser((changes[STORAGE_KEY]?.newValue as StoredGrant | undefined)?.user ?? null);
            }
        };

        chrome.storage.onChanged.addListener(listener);

        const load = async () => {
            const grant = await readGrant();

            if (!cancelled) {
                setUser(grant?.user ?? null);
            }
        };

        void load();

        return () => {
            cancelled = true;
            chrome.storage.onChanged.removeListener(listener);
        };
    }, []);

    return { isPending: user === undefined, user: user ?? null };
};

export const useSession = (): { data: ExtensionSession | null; isPending: boolean } => {
    const { isPending, user } = useGrantUser();

    return { data: user ? { sessionId: user.id, user } : null, isPending };
};
