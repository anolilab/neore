/**
 * The redirect URIs the app-grant sign-in may deliver a code to
 * (`auth/extension-grant.ts`). There is no extension ORIGIN list: no extension
 * origin is trusted for a cookie session or credentialed CORS, and the Worker
 * strips the cookie off any extension-origin request (`src/extension-cookie.ts`).
 */

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
 * The native shell's (`apps/desktop`) system-browser sign-in callback. Unlike
 * the extension URIs it is NOT exclusive — any app on the device can register
 * the `neore:` scheme — so it is never in the default: an operator opts in by
 * listing it. What keeps an interceptor from using a code is PKCE (RFC 8252
 * §8.1): the verifier never leaves the shell that started the flow. Codes
 * issued for it can only become a session COOKIE, through
 * `auth/client-grant-cookie.ts`.
 */
export const NATIVE_REDIRECT_URI = "neore://auth/callback";

/**
 * The mobile app's system-browser sign-in callback. Same trust model as
 * {@link NATIVE_REDIRECT_URI}: any app can register the scheme, so it is opt-in
 * only, matched exactly, and its codes go down the token path (not the cookie
 * path in `auth/client-grant-cookie.ts`).
 */
export const MOBILE_REDIRECT_URI = "neore-mobile://auth/callback";

const CHROME_EXTENSION_ID = /^(?:chrome-extension:\/\/)?(?<id>[a-p]{32})\/?$/;

/**
 * One `TRUSTED_EXTENSION_REDIRECT_URIS` entry as the URI it stands for. A Chrome
 * extension id, bare (as `chrome://extensions` shows it) or as
 * `chrome-extension://<id>`, is `https://<id>.chromiumapp.org/`, the URI
 * `identity.getRedirectURL()` derives from it. `getRedirectURL()` ends in "/";
 * a value copied without it gets one. The native callbacks stay as written.
 */
const normalizeRedirectUri = (entry: string): string => {
    const uri = entry.trim();
    const chromeId = CHROME_EXTENSION_ID.exec(uri)?.groups?.["id"];

    if (chromeId) {
        return `https://${chromeId}.chromiumapp.org/`;
    }

    if (!uri || uri === NATIVE_REDIRECT_URI || uri === MOBILE_REDIRECT_URI || uri.endsWith("/")) {
        return uri;
    }

    return `${uri}/`;
};

/**
 * `TRUSTED_EXTENSION_REDIRECT_URIS` → the exact redirect URIs the extension
 * sign-in flow may deliver a code to.
 *
 * UNSET means the shipped Firefox add-on's URI; the Chrome build's
 * `https://<id>.chromiumapp.org/` must be listed. That default is safe because of who can receive it:
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
 * {@link NATIVE_REDIRECT_URI} or {@link MOBILE_REDIRECT_URI}) is dropped with a warning.
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
        const uri = normalizeRedirectUri(entry);

        if (!uri) {
            continue;
        }

        if (uri === NATIVE_REDIRECT_URI || uri === MOBILE_REDIRECT_URI) {
            uris.push(uri);
            continue;
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

/** The entries a `TRUSTED_EXTENSION_REDIRECT_URIS` value lists, as written; unset is the default. */
const listedRedirectUris = (raw: string | undefined): string[] => {
    const trimmed = raw?.trim() ?? "";

    if (!trimmed) {
        return [SHIPPED_FIREFOX_REDIRECT_URI];
    }

    if (trimmed.toLowerCase() === "none") {
        return [];
    }

    return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
};

/**
 * For `pnpm dev:setup` (`scripts/dev-setup.js`): moves the Chrome ids of the
 * retired `TRUSTED_EXTENSION_ORIGINS` (`chrome-extension://<id>`) into
 * `TRUSTED_EXTENSION_REDIRECT_URIS` as `https://<id>.chromiumapp.org/`.
 *
 * A value replaces the default, so an unset list starts from the shipped
 * Firefox URI, and every entry already there (the desktop or mobile callback
 * among them) is kept. `none` stays: sign-in was switched off on purpose, so
 * the URIs that would have moved come back as `withheld`, for the script to
 * name. `added` is empty when nothing moved, and `value` is then the input
 * unchanged.
 */
export const carryRetiredExtensionOrigins = (
    origins: string | undefined,
    redirectUris: string | undefined,
): { added: string[]; value: string | undefined; withheld: string[] } => {
    const off = redirectUris?.trim().toLowerCase() === "none";
    const current = listedRedirectUris(redirectUris);
    const listed = new Set(current.map((entry) => normalizeRedirectUri(entry)));
    const added: string[] = [];
    const entries = origins?.split(",") ?? [];

    for (const entry of entries) {
        // The retired parser stripped every trailing slash, so `chrome-extension://<id>//` was a valid entry.
        let origin = entry.trim();

        while (origin.endsWith("/")) {
            origin = origin.slice(0, -1);
        }

        const uri = origin.startsWith("chrome-extension://") && CHROME_EXTENSION_ID.test(origin) ? normalizeRedirectUri(origin) : undefined;

        if (uri && !listed.has(uri)) {
            listed.add(uri);
            added.push(uri);
        }
    }

    if (off) {
        return { added: [], value: redirectUris, withheld: added };
    }

    return { added, value: added.length > 0 ? [...current, ...added].join(",") : redirectUris, withheld: [] };
};
