import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { getItemAsync, setItemAsync } from "expo-secure-store";

import type { StoredGrant } from "./grant";
import { secureGrantStore } from "./secure-store";
import { wasSignedOut } from "./sign-out";

/** The digest of the token of the grant the last sign-out ended. The token itself is never kept: it is a credential. */
const SIGNED_OUT_KEY = "neore.mobile.signed-out-grant";

/** A one-way digest of a session token, so the record can be compared without holding the token. */
const digestOf = async (token: string): Promise<string> => await digestStringAsync(CryptoDigestAlgorithm.SHA256, token);

/** Records that the grant with `token` was signed out, so the push task refuses it even if its clear failed. */
export const markGrantSignedOut = async (token: string): Promise<void> => {
    await setItemAsync(SIGNED_OUT_KEY, await digestOf(token));
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
        return wasSignedOut(await getItemAsync(SIGNED_OUT_KEY), await digestOf(grant.token)) ? undefined : grant;
    } catch {
        return undefined;
    }
};
