import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";

import type { GrantStore, StoredGrant } from "./grant";

const KEY = "neore.mobile.grant";

/** The session token at rest, in the iOS Keychain / Android Keystore. The JWT is never stored. */
export const secureGrantStore: GrantStore = {
    clear: async () => {
        await deleteItemAsync(KEY);
    },
    get: async () => {
        const raw = await getItemAsync(KEY);

        return raw === null ? null : (JSON.parse(raw) as StoredGrant);
    },
    set: async (grant) => {
        await setItemAsync(KEY, JSON.stringify(grant));
    },
};
