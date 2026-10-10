/**
 * Deletes runtime caches that earlier service workers filled and nothing
 * removes any more. Imported by the generated service worker
 * (`scripts/generate-sw.mjs` → `importScripts`). Plain JS and not bundled.
 *
 * Workbox's `cleanupOutdatedCaches` only removes stale PRECACHES; a runtime
 * cache survives every SW update once its rule is gone. These three held
 * per-user data:
 *
 * - `api-cache` — NetworkFirst over `/api/*`: auth sessions and tokens.
 * - `convex-http-cache` — the retired previous backend's HTTP responses (name kept: it is a runtime cache key this script deletes).
 * - `navigation-cache` — NetworkFirst over SSR HTML, which carries the viewer's
 *   dehydrated queries and RPC token; on a shared device the next user could be
 *   served the previous one's page. Navigations are now network-only with a
 *   static offline fallback.
 *
 * `scripts/sw-cache-cleanup.test.ts` runs this file against a fake worker scope.
 */
/* eslint-disable no-restricted-globals -- `self` is the service worker scope. */

self.addEventListener("activate", (event) => {
    // Inline rather than a top-level const: every `importScripts` file shares
    // the worker's global scope, so a top-level name could collide.
    event.waitUntil(Promise.all(["api-cache", "convex-http-cache", "navigation-cache"].map((name) => self.caches.delete(name))));
});
