import { getItemAsync, setItemAsync } from "expo-secure-store";

import type { StoredGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { wasSignedOut } from "./sign-out";

/** The token of the grant the last sign-out on this phone ended, kept where the headless push task can read it. */
const SIGNED_OUT_KEY = "neore.mobile.signed-out-grant";

/** Records that the grant with `token` was signed out, so the push task refuses it even if its clear failed. */
export const markGrantSignedOut = async (token: string): Promise<void> => {
    await setItemAsync(SIGNED_OUT_KEY, token);
};

/**
 * The sign-in on this phone, unless a sign-out ended it: a failed clear leaves that grant readable. A marker that cannot be
 * read counts as signed out, so a broken store shows nothing rather than an old account's text.
 */
export const readSignedInGrant = async (): Promise<StoredGrant | undefined> => {
    const grant = await secureGrantStore.get();

    if (!grant) {
        return undefined;
    }

    try {
        return wasSignedOut(grant, await getItemAsync(SIGNED_OUT_KEY)) ? undefined : grant;
    } catch {
        return undefined;
    }
};
