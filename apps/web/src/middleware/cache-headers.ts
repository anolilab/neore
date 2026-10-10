/**
 * Default `Cache-Control` for what the SSR Worker answers. Static files never
 * reach it — they are served by Workers Static Assets, whose headers live in
 * `public/_headers`.
 *
 * A header a route or handler already set always wins (robots.txt, sitemap,
 * better-auth); this only fills the gaps, which used to be every page and
 * every server function.
 *
 * - **Documents: `private, no-cache`.** SSR HTML carries a per-request CSP
 *   nonce and the viewer's dehydrated data, so no shared cache may keep it and
 *   the browser must revalidate. Deliberately NOT `no-store`: that disqualifies
 *   the page from the back/forward cache, turning every Back into a full
 *   reload.
 * - **Server functions: `private, no-store`.** They return session tokens and
 *   user data, some over GET (`getSessionToken`).
 */
export const applyDefaultCacheControl = (headers: Headers, handlerType: "router" | "serverFn"): void => {
    if (headers.has("Cache-Control")) {
        return;
    }

    if (handlerType === "serverFn") {
        headers.set("Cache-Control", "private, no-store");

        return;
    }

    if (headers.get("Content-Type")?.startsWith("text/html")) {
        headers.set("Cache-Control", "private, no-cache");
    }
};
