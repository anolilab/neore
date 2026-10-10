/**
 * Every Worker `alchemy.run.ts` deploys is bundled with `scripts/worker-bundle.ts`.
 *
 * Alchemy bundles each Worker itself and ignores `wrangler.jsonc`, so without an
 * explicit `bundle` the deploy ships an unminified development build — the
 * backend measured 19.9 MB raw / 3051 KiB gzip that way. `alchemy.run.ts` is not
 * typechecked and running it is the deploy, so this reads it as text, like
 * `deploy-env-bindings.test.ts`.
 *
 * The zod plugin rewrites an import inside zod, so the layout it relies on is
 * pinned against the installed zod: a zod release that moves the English
 * default or the `locales` namespace must fail here, not in production.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { BACKEND_BUNDLE, RUST_WORKER_UPLOAD, WORKER_BUNDLE, zodEnglishOnlyLocales } from "../scripts/worker-bundle";

const REPO_ROOT = join(import.meta.dirname, "..");
const alchemyScript = readFileSync(join(REPO_ROOT, "alchemy.run.ts"), "utf8");

const ENGLISH_REGISTERED_DIRECTLY = /import en from "\.\.\/locales\/en\.js";[\s\S]*config\(en\(\)\)/u;

/** Each `Worker("name", { … })` call's option block, up to its `bindings`. */
const workerCalls = [...alchemyScript.matchAll(/await Worker\("([^"]+)",\s*\{([\s\S]*?)\bbindings:/gu)].map(([, name, options]) => {
    return { name: name as string, options: options as string };
});

describe("deployed Worker bundles", () => {
    it("finds every bundled Worker in alchemy.run.ts", () => {
        expect(new Set(workerCalls.map(({ name }) => name))).toStrictEqual(
            new Set(["browser-renderer", "document-parser", "embeddings", "llm-gateway", "neore-backend", "nsfw-checker"]),
        );
    });

    it.each(workerCalls.filter(({ name }) => name !== "document-parser"))("$name is bundled with the shared options", ({ name, options }) => {
        expect(options).toContain("entrypoint:");
        expect(options).toContain(name === "neore-backend" ? "bundle: BACKEND_BUNDLE," : "bundle: WORKER_BUNDLE,");
    });

    it("uploads the Rust document-parser as built, from its worker-build output", () => {
        const parser = workerCalls.find(({ name }) => name === "document-parser");

        // worker-build already bundled and minified it; re-bundling would only wrap it.
        expect(parser?.options).toContain('entrypoint: "./build/index.js",');
        expect(parser?.options).toContain('cwd: "./services/document-parser",');
        expect(parser?.options).toContain("...RUST_WORKER_UPLOAD,");
        expect(parser?.options).not.toContain("bundle:");
        expect(RUST_WORKER_UPLOAD).toStrictEqual({ noBundle: true, rules: [{ globs: ["index.js", "index_bg.wasm"] }], sourceMap: false });
        // ... and the deploy refuses to start without that output.
        // eslint-disable-next-line no-template-curly-in-string -- the needle IS template-literal source text searched for in alchemy.run.ts
        expect(alchemyScript).toContain("existsSync(`./services/document-parser/build/${file}`)");
    });

    it("builds what wrangler.jsonc loads", () => {
        const wrangler = readFileSync(join(REPO_ROOT, "services/document-parser/wrangler.jsonc"), "utf8");

        expect(wrangler).toContain('"main": "build/index.js"');
        // Through pnpm, so it works from any cwd: `lunora dev`, CI and the deploy each start it elsewhere.
        expect(wrangler).toContain('"command": "pnpm --filter document-parser run build:worker"');
    });

    it("minifies, and gives the backend React's production build", () => {
        expect(WORKER_BUNDLE.minify).toBe(true);
        expect(BACKEND_BUNDLE.minify).toBe(true);
        expect(BACKEND_BUNDLE.define["process.env.NODE_ENV"]).toBe('"production"');
    });
});

describe("zodEnglishOnlyLocales", () => {
    type ResolveCallback = (args: { resolveDir: string }) => { namespace: string; path: string } | undefined;
    type LoadCallback = (args: { path: string }) => { contents: string; loader: "js"; resolveDir: string };

    const hooks = (() => {
        let resolve: { callback: ResolveCallback; filter: RegExp } | undefined;
        let load: LoadCallback | undefined;

        zodEnglishOnlyLocales.setup({
            onLoad: (_options, callback) => {
                load = callback;
            },
            onResolve: (options, callback) => {
                resolve = { callback, filter: options.filter };
            },
        });

        return { load: load as LoadCallback, resolve: resolve as { callback: ResolveCallback; filter: RegExp } };
    })();

    const zodRoot = dirname(createRequire(import.meta.url).resolve("zod/package.json"));

    it.each(["classic", "core", "mini"])("narrows the locales namespace imported by zod/v4/%s", (entry) => {
        const directory = join(zodRoot, "v4", entry);

        expect(hooks.resolve.filter.test("../locales/index.js")).toBe(true);
        expect(hooks.resolve.callback({ resolveDir: directory })?.path).toBe(join(zodRoot, "v4", "locales"));
    });

    it("leaves a locales/index.js outside zod alone", () => {
        expect(hooks.resolve.callback({ resolveDir: "/app/src/i18n" })).toBeUndefined();
    });

    it("keeps exactly the English catalogue", () => {
        const shim = hooks.load({ path: join(zodRoot, "v4", "locales") });

        expect(shim.contents).toBe(`export { default as en } from "./en.js";`);
        expect(readFileSync(join(shim.resolveDir, "en.js"), "utf8")).toContain("export default function");
    });

    it("matches the installed zod: English is registered without the locales namespace", () => {
        // The plugin is only behaviour-neutral while zod installs its default
        // locale from `../locales/en.js` rather than through `locales`.
        expect(readFileSync(join(zodRoot, "v4", "classic", "schemas.js"), "utf8")).toMatch(ENGLISH_REGISTERED_DIRECTLY);

        for (const entry of ["classic/external.js", "core/index.js", "mini/external.js"]) {
            expect(readFileSync(join(zodRoot, "v4", entry), "utf8")).toContain(`export * as locales from "../locales/index.js";`);
        }
    });
});
