import { makeRedirectUri } from "expo-auth-session";
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync, getRandomBytes } from "expo-crypto";
import { openAuthSessionAsync } from "expo-web-browser";

import { MOBILE_REDIRECT_URI } from "../lib/auth-config";
import type { GrantUser } from "./grant";
import { buildAuthorizeUrl, createPkce, exchangeGrant, parseAuthorizeResponse } from "./grant";
import { secureGrantStore } from "./secure-store";

/**
 * Sign-in through the system browser (SFSafariViewController / Custom Tabs): the
 * web app signs the user in and approves, then redirects to the app's scheme with
 * a one-time code. Browser-side PKCE is in `grant.ts`; this is the Expo glue.
 * Blocked until the backend accepts MOBILE_REDIRECT_URI (see auth-config.ts).
 */
export const signInWithBrowser = async (input: { appUrl: string; lunoraUrl: string }): Promise<GrantUser> => {
    // `native` pins the value; in Expo Go this would be an exp:// URL the backend never trusts.
    const redirectUri = makeRedirectUri({ native: MOBILE_REDIRECT_URI });

    const { challenge, state, verifier } = await createPkce({
        digestBase64: async (value) => await digestStringAsync(CryptoDigestAlgorithm.SHA256, value, { encoding: CryptoEncoding.BASE64 }),
        randomBytes: (count) => getRandomBytes(count),
    });

    const result = await openAuthSessionAsync(buildAuthorizeUrl({ appUrl: input.appUrl, challenge, redirectUri, state }), redirectUri);

    const code = parseAuthorizeResponse(result.type === "success" ? result.url : null, { redirectUri, state });

    return await exchangeGrant({
        code,
        fetch: (url, init) => fetch(url, init),
        lunoraUrl: input.lunoraUrl,
        redirectUri,
        store: secureGrantStore,
        verifier,
    });
};
