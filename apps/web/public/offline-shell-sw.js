/**
 * The desktop shell's offline cold start. Imported by the generated service
 * worker (`scripts/generate-sw.mjs` → `importScripts`), which defines
 * `self.__NEORE_OFFLINE_SHELL__ = { url, revision }` above it: the revision
 * changes with every client build, so each deploy keeps the shell that names
 * its own hashed assets. Plain JS and not bundled.
 *
 * - install: fetch `/offline-shell` with NO credentials and keep it in
 *   `neore-offline-shell-<revision>`. Best-effort: a failure never fails the
 *   install, it only leaves the shell missing. The server renders that path
 *   for nobody (`src/lib/offline-shell.ts`), so no session data is kept.
 * - activate: delete the shells of older revisions.
 * - fetch: in the Electron shell only, a navigation goes to the network as
 *   before; when the network FAILS (offline, DNS), the cached shell answers,
 *   then the precached `offline.html`. A server answer, even a 5xx, is
 *   returned as is. Browsers keep Workbox's own route (`offline.html`).
 *   Registered before Workbox's listener, so `stopImmediatePropagation` keeps
 *   Workbox from answering the same event twice.
 *
 * The cached response keeps the CSP header it was served with, and that
 * header's nonce is the one in its HTML, so the stale nonce still matches.
 *
 * `scripts/offline-shell-sw.test.ts` runs this file against a fake worker scope.
 */
/* eslint-disable no-restricted-globals -- `self` is the service worker scope. */

(() => {
    const config = self.__NEORE_OFFLINE_SHELL__;

    if (!config || typeof config.url !== "string" || typeof config.revision !== "string") {
        return;
    }

    const PREFIX = "neore-offline-shell-";
    const cacheName = PREFIX + config.revision;

    const isDesktopShell = () => /\bElectron\//u.test(self.navigator.userAgent);

    const keepShell = async () => {
        const response = await self.fetch(config.url, { cache: "no-store", credentials: "omit", redirect: "error" });

        if (response.status !== 200 || !(response.headers.get("Content-Type") ?? "").startsWith("text/html")) {
            return;
        }

        const cache = await self.caches.open(cacheName);

        await cache.put(config.url, response);
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
        if (event.request.mode !== "navigate" || !isDesktopShell()) {
            return;
        }

        event.stopImmediatePropagation();
        event.respondWith(self.fetch(event.request).catch((error) => offlineAnswer(error)));
    });
})();
