/**
 * A browser extension never authenticates with a cookie.
 *
 * Every build signs in through an app grant and sends its bearer
 * (`apps/browser-extension/src/lib/extension-grant.ts`), so its sends can be
 * told from the web app's. An extension page with host permissions is exempt
 * from CORS, though, and could still ride the web app's session cookie, which
 * the backend cannot tell from the web app's own. So a request from an
 * extension origin is stripped of its cookie before anything reads it: it
 * authenticates with its bearer or not at all. This also covers the web app's
 * `/api/auth/*` proxy, which forwards `Origin`.
 */
const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension|safari-web-extension):\/\//i;

const isExtensionOrigin = (origin: string | null): boolean => origin !== null && EXTENSION_ORIGIN.test(origin);

export const withoutExtensionCookie = (request: Request): Request => {
    if (!request.headers.has("cookie") || !isExtensionOrigin(request.headers.get("origin"))) {
        return request;
    }

    const headers = new Headers(request.headers);

    headers.delete("cookie");

    return new Request(request, { headers });
};
