/**
 * Rolldown options for the Workers `alchemy.run.ts` deploys.
 *
 * Alchemy bundles each Worker itself, from its `main` — it does NOT read
 * `wrangler.jsonc` and does not use `lunora build`'s output — and its defaults are
 * a development build: no minify. So the `"minify": true` in `backend/wrangler.jsonc`
 * never reaches the deploy. The backend measured 19.9 MB raw / 3051 KiB gzip
 * unminified under Alchemy 0.93's esbuild; Alchemy 2 bundles with rolldown, so the
 * size is re-measured by the first preview deploy (`.alchemy/bundles/<stack>-<stage>-<id>`).
 *
 * `alchemy.run.ts` cannot be run to check it (running it IS the deploy) and
 * `pnpm lint:types:deploy` only type-checks it, so this module is where the
 * options live and `backend/deploy-bundle.test.ts` is what pins their values.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The slice of rolldown's plugin API used here, so this file needs no rolldown import. */
interface BundlerPlugin {
    load: (id: string) => { code: string } | null;
    name: string;
    resolveId: (source: string, importer: string | undefined) => { id: string } | null;
}

const ZOD_LOCALES_PREFIX = "\0zod-english-only-locales:";

/**
 * Bundle only zod's English locale.
 *
 * `zod` and `zod/v4` export `z.locales` — all ~60 message catalogues, 251 KiB
 * minified — as a namespace object, and `import { z } from "zod/v4"` (which
 * every `@ai-sdk/*` provider uses) keeps the whole `z` namespace, so the bundler
 * cannot drop any of them. Nothing in these Workers selects a locale:
 * zod registers English itself (`v4/classic/schemas.js` imports
 * `../locales/en.js` directly, which this leaves alone), and
 * `z.locales.<lang>` is read nowhere. So the `locales` namespace is narrowed
 * to `en`; every message is byte-identical. A future `z.locales.de()` call
 * would fail as "not a function" — drop this plugin if one is ever wanted.
 */
export const zodEnglishOnlyLocales: BundlerPlugin = {
    load(id) {
        if (!id.startsWith(ZOD_LOCALES_PREFIX)) {
            return null;
        }

        // Absolute, because a virtual module has no directory to resolve `./en.js` from.
        const localesDir = id.slice(ZOD_LOCALES_PREFIX.length).replaceAll("\\", "/");

        return { code: `export { default as en } from "${localesDir}/en.js";` };
    },
    name: "zod-english-only-locales",
    resolveId(source, importer) {
        if (source !== "../locales/index.js" || importer === undefined) {
            return null;
        }

        const importerDir = path.dirname(importer);

        if (!/[/\\]zod[/\\]v4[/\\](?:classic|core|mini)$/u.test(importerDir)) {
            return null;
        }

        return { id: ZOD_LOCALES_PREFIX + path.join(importerDir, "../locales") };
    },
};

/**
 * For every bundled Worker (`Cloudflare.Worker`'s `build`). `keepNames` keeps class
 * and function names through the minifier, as Alchemy 0.x did underneath.
 */
export const WORKER_BUILD = {
    input: { plugins: [zodEnglishOnlyLocales] },
    output: { keepNames: true, minify: true },
};

/**
 * What `services/document-parser`'s build emits into `build/` and the deploy
 * uploads: worker-build's esbuild-bundled ES module and the wasm it imports.
 * (`build/worker/shim.mjs` and `package.json` sit there too; neither is loaded.)
 */
export const RUST_WORKER_OUTPUT = ["index.js", "index_bg.wasm"] as const;

/**
 * The Rust document parser is uploaded as built, not re-bundled (`bundle: false`):
 * worker-build already ran esbuild (minified) over the wasm-bindgen glue, and
 * rolldown would only wrap it again. `rules` names the two modules relative to the
 * entry's directory — the default (`**\/*.js`, `**\/*.mjs`, `**\/*.wasm`) would also
 * upload the unused shim.
 */
export const RUST_WORKER_UPLOAD = {
    bundle: false,
    rules: [{ globs: [...RUST_WORKER_OUTPUT] }],
};

/**
 * The backend additionally gets React's production builds (email rendering).
 * No backend source reads `process.env.NODE_ENV`; the only other readers in the
 * bundle are nanostores' dev-only helpers and the `ai` SDK's wording of a
 * Vercel-gateway auth error — and `lunora build` already bundles the
 * production branch.
 */
export const BACKEND_BUILD = {
    ...WORKER_BUILD,
    input: {
        ...WORKER_BUILD.input,
        transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
    },
};

/**
 * Cloudflare rejects a Worker whose modules add up to more than 64 MiB uncompressed. The
 * web app's SSR output is one chunk per `import()` target, and most of its 3,300 chunks
 * (about 68 MiB of JavaScript) are browser-only code the server never runs; the
 * spreadsheet editor alone is 12 MiB.
 *
 * These chunks are loaded only by a click or an effect in the browser, so they are
 * left out of the upload. Were the server ever to import one, the lazy boundary fails and
 * React renders that part on the client instead. Chunk names are `<name>-<hash>.js`.
 * (`xlsx` also covers `xlsx-convert`, the thin loader in front of it.)
 *
 * `video-trim-encode` is the reference-video trimmer, which bundles `mediabunny`; it is named after
 * its own module, so the entry is specific to it.
 */
export const WEB_CLIENT_ONLY_CHUNKS = ["elk", "jspdf.es.min", "pptxgen.es", "univer-sheet-editor", "video-trim-encode", "xlsx"] as const;

/** Wrangler's default module rules, minus {@link WEB_CLIENT_ONLY_CHUNKS}. */
export const WEB_UPLOAD_RULES = [
    { globs: ["**/*.js", "**/*.mjs", ...WEB_CLIENT_ONLY_CHUNKS.map((name) => `!**/${name}-*.js`)] },
    { globs: ["**/*.wasm"] },
    { globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
    { globs: ["**/*.bin"] },
];

/** The file extensions {@link WEB_UPLOAD_RULES} uploads. */
export const WEB_UPLOAD_EXTENSIONS = [".js", ".mjs", ".wasm", ".txt", ".html", ".sql", ".bin"] as const;

/** Where `lunora codegen` writes Studio's documents, relative to the repository root (`.lunora/studio-assets` from `backend/`). */
const BACKEND_STUDIO_ASSETS = "./backend/.lunora/studio-assets";

/**
 * The backend's Studio documents, as Workers Static Assets (anolilab/lunora#1499, anolilab/neore#494).
 *
 * `lunora codegen` writes the architecture manifest and the OpenAPI and OpenRPC specs to
 * `backend/.lunora/studio-assets/_lunora/studio/<name>.json`, and the generated app reads
 * them through an `ASSETS` binding (`loadStudioDocument`) on Studio's admin routes only, after
 * the admin-token check. `lunora deploy` gets the binding from the `assets` block reconcile
 * writes into `wrangler.jsonc`; Alchemy ignores that file, so `alchemy.run.ts` binds it here.
 *
 * `runWorkerFirst` is the literal `true`, never a path list: every request reaches the Worker
 * before the asset layer, so the files are served only through the binding. A path list
 * would leave `/_lunora/studio/*` assets-first and make the documents, which describe the whole
 * app, public. Alchemy names the binding `ASSETS` itself.
 *
 * The binding follows the directory, which Alchemy reads at plan time: codegen creates it
 * exactly when it chose asset mode, so a Lunora release without #1499 deploys with neither.
 * Mirroring codegen's decision with a version check would duplicate rules that also depend
 * on the project's shape. {@link backendStudioAssetsProblem} catches the one state that
 * cannot be right.
 *
 * `root` is the repository root; `alchemy.run.ts` passes `"."`, as Alchemy resolves the
 * relative `directory` against the working directory too.
 */
export const backendStudioAssets = (root: string): { directory: string; runWorkerFirst: true } | undefined =>
    existsSync(path.join(root, BACKEND_STUDIO_ASSETS)) ? { directory: path.join(root, BACKEND_STUDIO_ASSETS), runWorkerFirst: true } : undefined;

/**
 * A generated app that reads Studio's documents from `ASSETS` with no directory to bind:
 * Studio would show empty documents without an error anywhere, so the deploy refuses it.
 */
export const backendStudioAssetsProblem = (root: string): string | undefined => {
    if (backendStudioAssets(root) !== undefined) {
        return undefined;
    }

    const generatedApp = readFileSync(path.join(root, "backend/lunora/_generated/app.ts"), "utf8");

    return generatedApp.includes("loadStudioDocument")
        ? "backend/lunora/_generated/app.ts reads Studio's documents from the ASSETS binding, but backend/.lunora/studio-assets is missing. Run `pnpm --filter @neore/backend run codegen` first."
        : undefined;
};
