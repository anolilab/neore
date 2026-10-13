/**
 * Every Worker `alchemy.run.ts` deploys is bundled with `scripts/worker-bundle.ts`.
 *
 * Alchemy bundles each Worker itself (rolldown) and ignores `wrangler.jsonc`, so without
 * an explicit `build` the deploy ships an unminified development build — the backend
 * measured 19.9 MB raw / 3051 KiB gzip that way under Alchemy 0.x. `alchemy.run.ts` is not
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

import { BACKEND_BUILD, RUST_WORKER_UPLOAD, WEB_CLIENT_ONLY_CHUNKS, WEB_UPLOAD_RULES, WORKER_BUILD, zodEnglishOnlyLocales } from "../scripts/worker-bundle";

const REPO_ROOT = join(import.meta.dirname, "..");
const alchemyScript = readFileSync(join(REPO_ROOT, "alchemy.run.ts"), "utf8");

const ENGLISH_REGISTERED_DIRECTLY = /import en from "\.\.\/locales\/en\.js";[\s\S]*config\(en\(\)\)/u;

const WORKER_CALL_START = /Cloudflare\.Worker\("([^"]+)",\s*\{/u;
const ENGLISH_ONLY_RE_EXPORT = /^export \{ default as en \} from "[^"]+\/en\.js";$/u;

/** Each `Cloudflare.Worker("name", { … })` call's option block, up to the line that closes it with `});`. */
const workerCalls = (() => {
    const calls: { name: string; options: string }[] = [];
    const lines = alchemyScript.split("\n");

    for (const [index, line] of lines.entries()) {
        const start = WORKER_CALL_START.exec(line);

        if (!start) {
            continue;
        }

        const end = lines.findIndex((candidate, offset) => offset > index && candidate.trim() === "});");

        calls.push({ name: start[1] as string, options: lines.slice(index + 1, end).join("\n") });
    }

    return calls;
})();

describe("deployed Worker bundles", () => {
    it("finds every bundled Worker in alchemy.run.ts", () => {
        expect(new Set(workerCalls.map(({ name }) => name))).toStrictEqual(
            new Set(["browser-renderer", "document-parser", "llm-gateway", "neore-backend", "nsfw-checker", "website"]),
        );
    });

    it.each(workerCalls.filter(({ name }) => name !== "document-parser"))("$name is bundled with the shared options", ({ name, options }) => {
        // Bundled from source (`main`), or uploaded as the web app's own build output (`bundle: false`).
        expect(options).toContain("main:");

        if (name === "website") {
            expect(options).toContain("bundle: false,");
            expect(options).toContain('main: "./apps/web/dist/server/index.js",');

            return;
        }

        expect(options).toContain(name === "neore-backend" ? "build: BACKEND_BUILD," : "build: WORKER_BUILD,");
    });

    it("uploads the Rust document-parser as built, from its worker-build output", () => {
        const parser = workerCalls.find(({ name }) => name === "document-parser");

        // worker-build already bundled and minified it; re-bundling would only wrap it.
        expect(parser?.options).toContain('main: "./services/document-parser/build/index.js",');
        expect(parser?.options).toContain("...RUST_WORKER_UPLOAD,");
        expect(parser?.options).not.toContain("build:");
        expect(RUST_WORKER_UPLOAD).toStrictEqual({ bundle: false, rules: [{ globs: ["index.js", "index_bg.wasm"] }] });
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
        expect(WORKER_BUILD.output.minify).toBe(true);
        expect(BACKEND_BUILD.output.minify).toBe(true);
        // Class and function names survive the minifier, as they did under Alchemy 0.x.
        expect(WORKER_BUILD.output.keepNames).toBe(true);
        expect(BACKEND_BUILD.input.transform.define["process.env.NODE_ENV"]).toBe('"production"');
    });
});

describe("zodEnglishOnlyLocales", () => {
    const zodRoot = dirname(createRequire(import.meta.url).resolve("zod/package.json"));

    it.each(["classic", "core", "mini"])("narrows the locales namespace imported by zod/v4/%s", (entry) => {
        const importer = join(zodRoot, "v4", entry, "external.js");
        const resolved = zodEnglishOnlyLocales.resolveId("../locales/index.js", importer);

        expect(resolved).not.toBeNull();
        expect(zodEnglishOnlyLocales.load(resolved?.id as string)?.code).toBe(
            `export { default as en } from "${join(zodRoot, "v4", "locales").replaceAll("\\", "/")}/en.js";`,
        );
    });

    it("leaves a locales/index.js outside zod, and other imports, alone", () => {
        expect(zodEnglishOnlyLocales.resolveId("../locales/index.js", "/app/src/i18n/index.ts")).toBeNull();
        expect(zodEnglishOnlyLocales.resolveId("./other.js", join(zodRoot, "v4", "classic", "external.js"))).toBeNull();
        expect(zodEnglishOnlyLocales.resolveId("../locales/index.js", undefined)).toBeNull();
        expect(zodEnglishOnlyLocales.load("/app/src/real-module.ts")).toBeNull();
    });

    it("keeps exactly the English catalogue", () => {
        const resolved = zodEnglishOnlyLocales.resolveId("../locales/index.js", join(zodRoot, "v4", "core", "index.js"));
        const code = zodEnglishOnlyLocales.load(resolved?.id as string)?.code as string;

        expect(code).toMatch(ENGLISH_ONLY_RE_EXPORT);
        expect(readFileSync(join(zodRoot, "v4", "locales", "en.js"), "utf8")).toContain("export default function");
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

describe("web Worker upload", () => {
    it("is uploaded under the module rules that leave the browser-only chunks out", () => {
        const website = workerCalls.find(({ name }) => name === "website");

        expect(website?.options).toContain("rules: WEB_UPLOAD_RULES");
    });

    it("excludes every browser-only chunk and keeps wrangler's default module kinds", () => {
        const globs = WEB_UPLOAD_RULES.flatMap((rule) => rule.globs);

        for (const chunk of WEB_CLIENT_ONLY_CHUNKS) {
            expect(globs).toContain(`!**/${chunk}-*.js`);
        }

        expect(globs).toStrictEqual(expect.arrayContaining(["**/*.js", "**/*.mjs", "**/*.wasm"]));
    });
});
