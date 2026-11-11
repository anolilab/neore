/**
 * The desktop shell's offline cold start. Imported by the generated service
 * worker (`scripts/generate-sw.mjs` → `importScripts`), which defines
 * `self.__NEORE_OFFLINE_SHELL__ = { entry, revision, url }` above it: the
 * revision changes with every client build, so each deploy keeps the shell that
 * names its own hashed assets, and `entry` is that build's client entry chunk.
 * Plain JS and not bundled.
 *
 * - keep (install, and in the background after an online navigation at most
 *   every `REVALIDATE_MS`, so a server-only deploy that changes the shell's HTML
 *   or CSP reaches the cache too): fetch `/offline-shell` with NO credentials and
 *   keep it in `neore-offline-shell-<revision>`, but only when the HTML names
 *   `entry`: during a gradual deploy the request can reach the other version,
 *   whose HTML names assets this worker's build does not have. Best-effort and
 *   bounded by `SHELL_FETCH_TIMEOUT_MS`: a failure or a stall never fails or
 *   holds up the install, it only leaves the shell missing. The server renders
 *   that path for nobody (the `OFFLINE_SHELL_PATH` branch of
 *   `src/lib/root-before-load.ts`), so no session data is kept. Once this
 *   revision's shell is kept, the older revisions' shells are deleted.
 * - activate: delete the older shells only when this revision has one; until
 *   then the newest of them is the fallback.
 * - fetch: in the Electron shell only, a top-level GET document navigation goes
 *   to the network as before; when the network FAILS (offline, DNS), this
 *   revision's shell answers, else the newest older shell whose entry chunk this
 *   worker still has cached, else the precached `offline.html`. A server answer,
 *   even a 5xx, is returned as is. Iframe navigations (artifact and canvas
 *   previews), form POSTs and browsers keep Workbox's own route (`offline.html`).
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

    if (!config || typeof config.url !== "string" || typeof config.revision !== "string" || typeof config.entry !== "string") {
        return;
    }

    const PREFIX = "neore-offline-shell-";
    /** Covers the render and the body read: a stalled answer would otherwise hold the install open. */
    const SHELL_FETCH_TIMEOUT_MS = 10_000;
    /** How often an online navigation fetches a kept shell again. */
    const REVALIDATE_MS = 30 * 60 * 1000;
    /** The entry chunk a kept shell names, so an older shell can be checked against what this worker has. */
    const ENTRY_HEADER = "X-Neore-Shell-Entry";
    /** When the shell was kept: the throttle outlives the worker, which stops whenever it is idle. */
    const KEPT_AT_HEADER = "X-Neore-Shell-Kept-At";
    const cacheName = PREFIX + config.revision;

    const isDesktopShell = () => /\bElectron\//u.test(self.navigator.userAgent);

    const currentShell = async () => await (await self.caches.open(cacheName)).match(config.url);

    /** Deletes the shells of older revisions. */
    const dropOlderShells = async () => {
        const names = await self.caches.keys();

        await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== cacheName).map((name) => self.caches.delete(name)));
    };

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

        const headers = new Headers(response.headers);

        headers.set(ENTRY_HEADER, config.entry);
        headers.set(KEPT_AT_HEADER, String(Date.now()));

        const cache = await self.caches.open(cacheName);

        await cache.put(config.url, new Response(body, { headers, status: 200 }));
        await dropOlderShells();
    };

    let refreshing;

    /** Keeps the shell when it is missing, else fetches it again every `REVALIDATE_MS`; one attempt at a time. */
    const refreshShell = () => {
        refreshing ??= currentShell()
            .then((kept) => (kept && Date.now() - Number(kept.headers.get(KEPT_AT_HEADER)) < REVALIDATE_MS ? undefined : keepShell()))
            .catch(() => undefined)
            .finally(() => {
                refreshing = undefined;
            });

        return refreshing;
    };

    /** The newest older shell whose entry chunk this worker still has cached (precache or `bundle-assets`). */
    const olderShell = async () => {
        const names = (await self.caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== cacheName);

        // Cache Storage lists names in creation order: the newest is last.
        for (const name of names.toReversed()) {
            const shell = await (await self.caches.open(name)).match(config.url);
            const entry = shell?.headers.get(ENTRY_HEADER);

            if (entry && (await self.caches.match(`/${entry}`))) {
                return shell;
            }
        }

        return undefined;
    };

    const offlineAnswer = async (error) => {
        const shell = (await currentShell()) ?? (await olderShell());

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
        event.waitUntil(currentShell().then((kept) => (kept ? dropOlderShells() : undefined)));
    });

    self.addEventListener("fetch", (event) => {
        const { request } = event;

        if (request.method !== "GET" || request.mode !== "navigate" || request.destination !== "document" || !isDesktopShell()) {
            return;
        }

        const network = self.fetch(request);

        event.stopImmediatePropagation();
        event.respondWith(network.catch((error) => offlineAnswer(error)));
        // The network is up: keep the shell if it is missing, and revalidate it now and then.
        event.waitUntil(network.then(refreshShell, () => undefined));
    });
})();
