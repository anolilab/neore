import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";

import type { GrantStore, StoredGrant } from "./grant";
import { serializeGrantStore } from "./grant";

const KEY = "neore.mobile.grant";

/** The session token at rest, in the iOS Keychain / Android Keystore. The JWT is never stored. */
const keychainGrantStore: GrantStore = {
    clear: async () => {
        await deleteItemAsync(KEY);
    },
    get: async () => {
        const raw = await getItemAsync(KEY);

        if (raw === null) {
            // eslint-disable-next-line unicorn/no-null -- `GrantStore.get` answers null when signed out; the callers compare with null
            return null;
        }

        try {
            return JSON.parse(raw) as StoredGrant;
        } catch {
            // A damaged value can never sign anyone in: drop it, so the session reads as signed out.
            await deleteItemAsync(KEY);

            // eslint-disable-next-line unicorn/no-null -- same contract as above: a signed-out result is null
            return null;
        }
    },
    set: async (grant) => {
        await setItemAsync(KEY, JSON.stringify(grant));
    },
};

/**
 * The app's grant store: every read, write and clear in one queue (`serializeGrantStore`), so a refused mint's
 * check-and-clear can never delete a grant a sign-in stores at the same time.
 */
export const secureGrantStore: GrantStore = serializeGrantStore(keychainGrantStore);
