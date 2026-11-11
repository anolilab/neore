/**
 * The desktop shell's offline cold start. Imported by the generated service
 * worker (`scripts/generate-sw.mjs` → `importScripts`), which defines
 * `self.__NEORE_OFFLINE_SHELL__ = { entry, revision, url }` above it: the
 * revision changes with every client build, so each deploy keeps the shell that
 * names its own hashed assets, and `entry` is that build's client entry chunk.
 * Plain JS and not bundled.
 *
 * - install (Electron only): fetch `/offline-shell` with NO credentials and keep
 *   it in `neore-offline-shell-<revision>`, but only when the HTML names
 *   `entry`: during a gradual deploy the request can reach the other version,
 *   whose HTML names assets this worker's build does not have. Best-effort and
 *   bounded by `SHELL_FETCH_TIMEOUT_MS`: a failure or a stall never fails or
 *   holds up the install, it only leaves the shell missing. The server renders
 *   that path for nobody (`src/lib/offline-shell.ts`), so no session data is kept.
 * - activate: delete the shells of older revisions.
 * - fetch: in the Electron shell only, a top-level document navigation goes to
 *   the network as before; when the network FAILS (offline, DNS), the cached
 *   shell answers, then the precached `offline.html`. A server answer, even a
 *   5xx, is returned as is, and when the shell is missing (the install could
 *   not keep it) it is fetched again in the background. Iframe navigations
 *   (artifact and canvas previews) and browsers keep Workbox's own route
 *   (`offline.html`). Registered before Workbox's listener, so
 *   `stopImmediatePropagation` keeps Workbox from answering the same event twice.
 *
 * The cached response keeps the CSP header it was served with, and that
 * header's nonce is the one in its HTML, so the stale nonce still matches.
 *
 * `scripts/offline-shell-sw.test.ts` runs this file against a fake worker scope.
 */
/* eslint-disable no-restricted-globals -- `self` is the service worker scope. */

(() => {
    const config = self.__NEORE_OFFLINE_SHELL__;

    if (!config || typeof config.url !== "string" || typeof config.revision !== "string" || typeof config.entry !== "string") {
        return;
    }

    const PREFIX = "neore-offline-shell-";
    /** Covers the render and the body read: a stalled answer would otherwise hold the install open. */
    const SHELL_FETCH_TIMEOUT_MS = 10_000;
    const cacheName = PREFIX + config.revision;

    const isDesktopShell = () => /\bElectron\//u.test(self.navigator.userAgent);

    const keepShell = async () => {
        const response = await self.fetch(config.url, {
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(SHELL_FETCH_TIMEOUT_MS),
        });

        if (response.status !== 200 || !(response.headers.get("Content-Type") ?? "").startsWith("text/html")) {
            return;
        }

        const body = await response.text();

        // Rendered by another version of the site (gradual deploy): its assets are not this build's.
        if (!body.includes(config.entry)) {
            return;
        }

        const cache = await self.caches.open(cacheName);

        await cache.put(config.url, new Response(body, { headers: response.headers, status: 200 }));
    };

    let refilling;

    /** Keeps the shell if the install could not; one attempt at a time. */
    const refillShell = () => {
        refilling ??= self.caches
            .open(cacheName)
            .then((cache) => cache.match(config.url))
            .then((kept) => (kept ? undefined : keepShell()))
            .catch(() => undefined)
            .finally(() => {
                refilling = undefined;
            });

        return refilling;
    };

    const offlineAnswer = async (error) => {
        const shell = await (await self.caches.open(cacheName)).match(config.url);

        if (shell) {
            return shell;
        }

        // Workbox keys a revisioned precache entry with `?__WB_REVISION__=`.
        const fallback = await self.caches.match("/offline.html", { ignoreSearch: true });

        if (fallback) {
            return fallback;
        }

        throw error;
    };

    self.addEventListener("install", (event) => {
        if (!isDesktopShell()) {
            return;
        }

        event.waitUntil(keepShell().catch(() => undefined));
    });

    self.addEventListener("activate", (event) => {
        event.waitUntil(
            self.caches
                .keys()
                .then((names) => Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== cacheName).map((name) => self.caches.delete(name)))),
        );
    });

    self.addEventListener("fetch", (event) => {
        if (event.request.mode !== "navigate" || event.request.destination !== "document" || !isDesktopShell()) {
            return;
        }

        const network = self.fetch(event.request);

        event.stopImmediatePropagation();
        event.respondWith(network.catch((error) => offlineAnswer(error)));
        // The network is up again: keep the shell if it is missing.
        event.waitUntil(network.then(refillShell, () => undefined));
    });
})();
