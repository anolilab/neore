import { createConfig } from "@anolilab/eslint-config";

/** @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer} */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**", "./.wrangler/**"],
        // `vitest: false`, matching backend/ and apps/web. The plugin's
        // `unbound-method` rule needs type-aware parser services, and this config is
        // not type-aware — with the plugin on, eslint crashes rather than reporting.
        vitest: false,
        typescript: {
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
            ignoresTypeAware: ["*.json", "*.md"],
        },
    },
    {
        // Source files only. `files: ["**/*"]` also matches `package.json` and
        // `tsconfig.json`, which eslint 10 parses as `jsonc/x` — and a JS-only
        // rule named for a language that does not support it is a hard error,
        // not a skipped rule. It surfaced twice: `unicorn/*` reported as
        // unsupported, and `no-secrets/no-secrets` as a missing plugin, because
        // the shared config deliberately excludes those two files from its
        // no-secrets block, so the plugin is out of scope exactly there.
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * The same four zod rules `backend/eslint.config.js` disables, for the
             * same reasons — three of them silently change what a schema ACCEPTS at
             * runtime, and `consistent-import`'s fix is outright broken.
             *
             * `consistent-import` rewrites `import { z } from "zod"` into named
             * imports and emits `enum` — a reserved word — so the file stops
             * parsing. Running `--fix` here produced 259 TypeScript errors and took
             * the suite from 462 tests to 333 before this was turned off.
             *
             * `prefer-string-schema-with-trim` turns `z.string()` into
             * `z.string().trim()`, silently trimming ids, hashes and tokens where a
             * stray space should be an error. `prefer-strict-object` turns
             * `z.object()` into `z.strictObject()`, rejecting unknown keys — which
             * breaks every caller sending a field not modelled yet.
             * `no-optional-and-default-together` changes whether a key may be absent
             * versus present-and-undefined.
             */
            "zod/consistent-import": "off",
            "zod/no-optional-and-default-together": "off",
            "zod/prefer-strict-object": "off",
            "zod/prefer-string-schema-with-trim": "off",

            /**
             * The same calibrations `backend/eslint.config.js` reached, applied to a
             * near-identical distribution of findings. See that file for the
             * per-rule reasoning; the short version:
             *
             * `no-null` — this service speaks to D1 and to JSON APIs, where `null`
             * is the wire value, not a smell. `no-top-level-side-effects` — a Hono
             * app IS built by top-level `app.route(...)` calls. `exports-last` /
             * `prefer-default-export` / `func-style` / `filename-case` — house style
             * that the codebase already contradicts consistently.
             * `n/no-unsupported-features/node-builtins` — this runs on Workers, not
             * Node, so `crypto` and `ReadableStream` are standard globals.
             * `no-await-in-loop` — sequential awaits are deliberate where each pass
             * depends on the last (key-pool failover, paged reads).
             *
             * The three left as warnings are ones worth seeing but not blocking on:
             * a non-null assertion, a deeply nested call and a complex function are
             * each sometimes right, and each is a judgement the author has to make.
             */
            "@typescript-eslint/explicit-member-accessibility": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-non-null-assertion": "warn",
            "antfu/if-newline": "off",
            "func-style": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "jsdoc/check-indentation": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "no-await-in-loop": "off",
            "no-plusplus": "off",
            "sonarjs/cognitive-complexity": "warn",
            "unicorn/max-nested-calls": ["error", { max: 9 }],
            "unicorn/no-null": "off",
            "unicorn/no-top-level-side-effects": "off",
            "unicorn/prefer-await": "off",

            // Second batch, same source. `ctx`/`env`/`db`/`i` are the names this
            // codebase uses everywhere and nobody is confused by them.
            "unicorn/name-replacements": [
                "error",
                {
                    checkDefaultAndNamespaceImports: false,
                    checkShorthandImports: false,
                    checkShorthandProperties: false,
                    replacements: {
                        args: false,
                        ctx: false,
                        db: false,
                        doc: false,
                        docs: false,
                        env: false,
                        i: false,
                        j: false,
                        params: false,
                        prop: false,
                        props: false,
                        ref: false,
                        refs: false,
                        // `res` is the Response in every Hono handler and fetch call here.
                        res: false,
                    },
                },
            ],
            // Hoisted helpers below their use sites read fine and are the existing
            // shape here; the hazard the rule guards is a `const` in the TDZ.
            "@typescript-eslint/no-use-before-define": ["error", { classes: true, enums: true, functions: false, typedefs: false, variables: false }],
            "class-methods-use-this": "off",
            "no-bitwise": "off",
            "no-underscore-dangle": "off",
            // Every finding here is a model id, a provider slug or a test fixture.
            "no-secrets/no-secrets": "warn",
            "unicorn/no-break-in-nested-loop": "off",
            // kebab-case, but `__tests__` is a conventional directory name, not a
            // style slip — the rule checks every path segment and wants `__tests`.
            "unicorn/filename-case": ["error", { case: "kebabCase", ignore: [String.raw`__tests__`] }],
        },
    },
);
