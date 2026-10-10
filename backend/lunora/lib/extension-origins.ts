/**
 * `TRUSTED_EXTENSION_ORIGINS` → the browser-extension origins the backend trusts
 * for credentialed CORS (`http.ts`) and better-auth's origin check (`auth.ts`).
 *
 * Optional: unset means the browser extension simply cannot sign in. It must
 * NEVER widen to "any extension" — trusting every installed extension would let
 * any of them drive authenticated requests — so this parses to an exact list,
 * and anything that is not one concrete extension origin (`*`, a bare scheme, a
 * web origin, a typo) is dropped with a warning rather than honoured.
 */
const EXTENSION_ORIGIN = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/;

/** Strips trailing slashes without a backtracking-prone regex. */
const withoutTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

export const parseTrustedExtensionOrigins = (raw: string | undefined): string[] => {
    const origins: string[] = [];
    const entries = (raw ?? "").split(",");

    for (const entry of entries) {
        const origin = withoutTrailingSlashes(entry.trim());

        if (!origin) {
            continue;
        }

        if (EXTENSION_ORIGIN.test(origin)) {
            origins.push(origin);
        } else {
            console.warn(`[env] TRUSTED_EXTENSION_ORIGINS: ignoring "${origin}" — expected chrome-extension://<32-letter id> or moz-extension://<uuid>`);
        }
    }

    return [...new Set(origins)];
};

/**
 * A `launchWebAuthFlow` redirect URI. The browser intercepts navigation to it and
 * hands the URL to the extension WITHOUT loading it, and only for the extension
 * whose id it was derived from — which is what makes it safe to send a one-time
 * code there (see `auth/extension-grant.ts`):
 *
 * - Firefox: `https://<SHA-1 of the add-on id, hex>.extensions.allizom.org/`
 *   (`identity.getRedirectURL()`; the hash is 40 hex characters).
 * - Chrome: `https://<32-letter id>.chromiumapp.org/`.
 */
const EXTENSION_REDIRECT_URI = /^https:\/\/(?:[\da-f]{40}\.extensions\.allizom\.org|[a-p]{32}\.chromiumapp\.org)\/$/;

/**
 * The add-on id the Firefox build ships with — `GECKO_ID` in
 * `apps/browser-extension/src/manifest/build-manifest.ts`.
 */
export const SHIPPED_FIREFOX_EXTENSION_ID = "anole-chat@neore.ai";

/**
 * `identity.getRedirectURL()` for {@link SHIPPED_FIREFOX_EXTENSION_ID}:
 * `https://${sha1hex(id)}.extensions.allizom.org/`. A literal because the
 * Workers runtime has only async hashing and this is read at module load;
 * `extension-origins.test.ts` recomputes it, so an id change cannot leave it stale.
 */
export const SHIPPED_FIREFOX_REDIRECT_URI = "https://c64d88ed4645bb5915bc267506fbc3dcd4a1da90.extensions.allizom.org/";

/**
 * The native shell's (`apps/native`) system-browser sign-in callback. Unlike
 * the extension URIs it is NOT exclusive — any app on the device can register
 * the `neore:` scheme — so it is never in the default: an operator opts in by
 * listing it. What keeps an interceptor from using a code is PKCE (RFC 8252
 * §8.1): the verifier never leaves the shell that started the flow. Codes
 * issued for it can only become a session COOKIE, through
 * `auth/client-grant-cookie.ts`.
 */
export const NATIVE_REDIRECT_URI = "neore://auth/callback";

/**
 * `TRUSTED_EXTENSION_REDIRECT_URIS` → the exact redirect URIs the extension
 * sign-in flow may deliver a code to.
 *
 * UNSET means the shipped Firefox add-on's URI, unlike `TRUSTED_EXTENSION_ORIGINS`
 * where unset means none. That default is safe because of who can receive it:
 * Firefox intercepts the URI only for the add-on whose id it derives from, AMO
 * signs one add-on per id, and a release Firefox runs only signed add-ons. The
 * one other way to hold that id is a temporary or unsigned install the user put
 * in their own browser, and an extension installed that way already has access
 * to anything the code would give it. The code is useless without that
 * extension's PKCE verifier too, and the user must still sign in and click
 * Connect. An origin default would be different: any page can SEND an `Origin`
 * header, but only a browser can be handed a redirect URI.
 *
 * `none` turns the Firefox sign-in off. A value replaces the default; it does
 * not add to it. The list never widens: an arbitrary URL here would let any page
 * that starts the flow receive a code, so everything that is not a
 * browser-intercepted extension redirect URI (or, opted into, exactly
 * {@link NATIVE_REDIRECT_URI}) is dropped with a warning.
 */
export const parseTrustedExtensionRedirectUris = (raw: string | undefined): string[] => {
    const trimmed = raw?.trim() ?? "";

    if (!trimmed) {
        return [SHIPPED_FIREFOX_REDIRECT_URI];
    }

    if (trimmed.toLowerCase() === "none") {
        return [];
    }

    const uris: string[] = [];
    const entries = trimmed.split(",");

    for (const entry of entries) {
        let uri = entry.trim();

        if (!uri) {
            continue;
        }

        if (uri === NATIVE_REDIRECT_URI) {
            uris.push(uri);
            continue;
        }

        // `getRedirectURL()` ends in "/"; accept the value copied without it.
        if (!uri.endsWith("/")) {
            uri += "/";
        }

        if (EXTENSION_REDIRECT_URI.test(uri)) {
            uris.push(uri);
        } else {
            console.warn(
                `[env] TRUSTED_EXTENSION_REDIRECT_URIS: ignoring "${uri}" — expected https://<sha1 hex>.extensions.allizom.org/ or https://<id>.chromiumapp.org/`,
            );
        }
    }

    return [...new Set(uris)];
};
