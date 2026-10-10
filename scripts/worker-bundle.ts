/**
 * esbuild options for the Workers `alchemy.run.ts` deploys.
 *
 * Alchemy bundles each Worker itself, from its `entrypoint` — it does NOT read
 * `wrangler.jsonc` and does not use `lunora build`'s output — and its defaults
 * are a development build: no minify, and `process.env.NODE_ENV` defined as the
 * string "undefined". So the `"minify": true` in `backend/wrangler.jsonc` never
 * reached the deploy. Measured with Alchemy's own bundler (0.93.12) on
 * 2026-09-25, the backend would go out at 19.9 MB raw / 3051 KiB gzip — at the
 * Free plan's 3 MB limit — carrying React's development builds.
 *
 * `alchemy.run.ts` cannot be run to check it (running it IS the deploy) and
 * `pnpm lint:types:deploy` only type-checks it, so this module is where the
 * options live and `backend/deploy-bundle.test.ts` is what pins their values.
 */
import path from "node:path";

/** The slice of esbuild's plugin API used here, so this file needs no esbuild import. */
interface BundlerPlugin {
    name: string;
    setup: (build: {
        onLoad: (
            options: { filter: RegExp; namespace: string },
            callback: (args: { path: string }) => { contents: string; loader: "js"; resolveDir: string },
        ) => void;
        onResolve: (options: { filter: RegExp }, callback: (args: { resolveDir: string }) => { namespace: string; path: string } | undefined) => void;
    }) => void;
}

const ZOD_LOCALES_NAMESPACE = "zod-english-only-locales";

/**
 * Bundle only zod's English locale.
 *
 * `zod` and `zod/v4` export `z.locales` — all ~60 message catalogues, 251 KiB
 * minified — as a namespace object, and `import { z } from "zod/v4"` (which
 * every `@ai-sdk/*` provider uses) keeps the whole `z` namespace, so esbuild
 * cannot drop any of them. Nothing in these Workers selects a locale:
 * zod registers English itself (`v4/classic/schemas.js` imports
 * `../locales/en.js` directly, which this leaves alone), and
 * `z.locales.<lang>` is read nowhere. So the `locales` namespace is narrowed
 * to `en`; every message is byte-identical. A future `z.locales.de()` call
 * would fail as "not a function" — drop this plugin if one is ever wanted.
 */
export const zodEnglishOnlyLocales: BundlerPlugin = {
    name: ZOD_LOCALES_NAMESPACE,
    setup(build) {
        // No `u` flag on either filter: esbuild compiles them as Go regexps and
        // rejects the `(?u)` it would translate that flag into.
        build.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, ({ resolveDir }) => {
            if (!/[/\\]zod[/\\]v4[/\\](?:classic|core|mini)$/u.test(resolveDir)) {
                return undefined;
            }

            return { namespace: ZOD_LOCALES_NAMESPACE, path: path.join(resolveDir, "../locales") };
        });
        build.onLoad({ filter: /.*/, namespace: ZOD_LOCALES_NAMESPACE }, (args) => {
            return { contents: `export { default as en } from "./en.js";`, loader: "js", resolveDir: args.path };
        });
    },
};

/** For every deployed Worker. Alchemy keeps `keepNames: true` underneath, so class and function names survive minify. */
export const WORKER_BUNDLE = {
    minify: true,
    plugins: [zodEnglishOnlyLocales],
};

/**
 * What `services/document-parser`'s build emits into `build/` and the deploy
 * uploads: worker-build's esbuild-bundled ES module and the wasm it imports.
 * (`build/worker/shim.mjs` and `package.json` sit there too; neither is loaded.)
 */
export const RUST_WORKER_OUTPUT = ["index.js", "index_bg.wasm"] as const;

/**
 * The Rust document parser is uploaded as built, not re-bundled: worker-build
 * already ran esbuild (minified) over the wasm-bindgen glue, and Alchemy's own
 * bundle would only wrap it again. `rules` names the two modules relative to
 * the entrypoint's directory — Alchemy's default (`**\/*.js`, `**\/*.mjs`,
 * `**\/*.wasm`) would also upload the unused shim. No source maps exist for it.
 */
export const RUST_WORKER_UPLOAD = {
    noBundle: true,
    rules: [{ globs: [...RUST_WORKER_OUTPUT] }],
    sourceMap: false,
};

/**
 * The backend additionally gets React's production builds (email rendering).
 * No backend source reads `process.env.NODE_ENV`; the only other readers in the
 * bundle are nanostores' dev-only helpers and the `ai` SDK's wording of a
 * Vercel-gateway auth error — and `lunora build` already bundles the
 * production branch.
 */
export const BACKEND_BUNDLE = {
    ...WORKER_BUNDLE,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
};
