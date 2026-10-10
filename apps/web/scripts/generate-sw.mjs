/**
 * Post-build service worker generation script.
 *
 * Generates a production service worker using workbox-build after
 * the Vite/TanStack Start build completes.
 *
 * Usage: node scripts/generate-sw.mjs
 */

import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { generateSW } from "workbox-build";

const clientDir = resolve(import.meta.dirname, "../dist/client");

/**
 * Vite's content hash in an output name (`index-Bk9j37oz.js`). Workbox gives
 * matching URLs no revision, which also means it fetches them with the default
 * cache mode — so installing the SW reads the shell from the HTTP cache the
 * page just filled (`/assets/*` is `immutable`, see public/_headers) instead of
 * downloading it a second time with `cache: "reload"`.
 */
const HASHED_ASSET_RE = /-[\w-]{8}\.\w+$/u;

/** Static, user-agnostic page served for a navigation the network failed. */
const OFFLINE_FALLBACK_URL = "/offline.html";

/**
 * The app shell: the client entry and everything it imports STATICALLY, JS and
 * CSS only. That is what every page needs before it can render, so it is what
 * an offline start needs; everything else (route chunks, lazy editors, fonts)
 * is runtime-cached by `bundle-assets` / `static-assets` the first time a page
 * actually uses it.
 *
 * Precaching the whole build instead (every file under 2 MiB) made a first
 * visit download ~940 files / ~36 MB in the background, in competition with the
 * page's own lazy chunks, for code most sessions never reach.
 */
const readAppShell = () => {
    const manifestDir = resolve(clientDir, ".vite");
    const manifest = JSON.parse(readFileSync(resolve(manifestDir, "manifest.json"), "utf8"));

    // Build metadata, not an asset: everything in dist/client is deployed as a
    // public static file, and the manifest maps every source path to its chunk.
    rmSync(manifestDir, { force: true, recursive: true });
    const files = new Set();
    const seen = new Set();

    const walk = (key) => {
        if (seen.has(key)) {
            return;
        }

        seen.add(key);

        const chunk = manifest[key];

        files.add(chunk.file);

        for (const css of chunk.css ?? []) {
            files.add(css);
        }

        for (const imported of chunk.imports ?? []) {
            walk(imported);
        }
    };

    for (const [key, chunk] of Object.entries(manifest)) {
        if (chunk.isEntry) {
            walk(key);
        }
    }

    if (files.size === 0) {
        throw new Error("No entry chunk in .vite/manifest.json — is `build.manifest` still enabled?");
    }

    return [...files];
};

try {
    const { count, size, warnings } = await generateSW({
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        globDirectory: clientDir,
        dontCacheBustURLsMatching: HASHED_ASSET_RE,
        globIgnores: ["**/node_modules/**", "sw.js", "workbox-*.js"],
        // The shell, plus the root-level icons and manifest the install prompt
        // and an offline start need. Nothing else — see readAppShell.
        globPatterns: [...readAppShell(), "*.{ico,svg}", "manifest.json", OFFLINE_FALLBACK_URL.slice(1)],
        // Plain JS the generated worker imports, so its handlers survive every
        // regeneration: Web Push (`push` / `notificationclick`) and the
        // `activate` sweep of runtime caches older workers left behind.
        importScripts: ["push-sw.js", "sw-cache-cleanup.js"],
        runtimeCaching: [
            // Cache-first for static assets (fonts, images)
            {
                handler: "CacheFirst",
                options: {
                    cacheName: "static-assets",
                    expiration: {
                        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                        maxEntries: 200,
                    },
                },
                urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|avif|ico|woff|woff2)$/,
            },
            // Cache-first for JS/CSS bundles (hashed filenames). This now holds
            // every non-shell chunk a session touches, so it is sized for the
            // route chunks of a few deploys rather than a handful of files.
            {
                handler: "CacheFirst",
                options: {
                    cacheName: "bundle-assets",
                    expiration: {
                        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                        maxEntries: 400,
                        purgeOnQuotaError: true,
                    },
                },
                urlPattern: /\/assets\/.*\.(?:js|css)$/,
            },
            // No rule for `/api/*`. It used to be NetworkFirst, which copied every
            // auth response (sessions, tokens) into Cache Storage and, after a 10s
            // network stall, answered with a stale session. An unrouted request
            // goes straight to the network with no SW overhead.
            // Navigations are network-ONLY. SSR HTML carries the viewer's
            // dehydrated queries and their RPC token (the root `beforeLoad`
            // context), so a cached page is one user's data on disk — and the
            // old NetworkFirst `navigation-cache` served it, after a 5s stall or
            // offline, to whoever used the device next. When the network fails
            // the answer is the static, precached `offline.html` instead.
            // `public/sw-cache-cleanup.js` deletes the old cache.
            {
                handler: "NetworkOnly",
                options: {
                    precacheFallback: { fallbackURL: OFFLINE_FALLBACK_URL },
                },
                urlPattern: ({ request }) => request.mode === "navigate",
            },
        ],
        skipWaiting: true,
        swDest: resolve(clientDir, "sw.js"),
    });

    /**
     * Workbox reports every over-limit file as a warning. Here that is the
     * intended outcome, not a problem: those chunks are deliberately left to the
     * runtime `bundle-assets` CacheFirst rule.
     *
     * They are separated rather than suppressed. Printing them as warnings
     * trained everyone to skip this block — which is how a stale `globIgnores`
     * entry naming `vendor-heavy-*.js` survived that chunk being renamed to
     * `vendor-diagrams`, with the only signal buried among them.
     */
    const expected = warnings.filter((warning) => warning.includes("won't be precached"));
    const unexpected = warnings.filter((warning) => !warning.includes("won't be precached"));

    for (const warning of expected) {
        console.log(
            `[generate-sw] runtime-cached, not precached: ${warning.replace(", and won't be precached. Configure maximumFileSizeToCacheInBytes to change this limit.", "")}`,
        );
    }

    if (unexpected.length > 0) {
        console.warn("[generate-sw] Warnings:");

        for (const warning of unexpected) {
            console.warn(`  - ${warning}`);
        }
    }

    console.log(`[generate-sw] Generated service worker: ${count} files precached, ${(size / 1024 / 1024).toFixed(2)} MB total`);
} catch (error) {
    console.error("[generate-sw] Failed to generate service worker:", error);
    process.exit(1);
}
