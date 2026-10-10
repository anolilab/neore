import { createConfig } from "@anolilab/eslint-config";

/**
 * `packages/ai` had no eslint config, so `eslint .` resolved up to the repo-root
 * `eslint.config.mjs` — which registers no TypeScript parser. Every `.ts` file
 * reported `Parsing error: Unexpected token` and no rule ever ran, so the 27
 * "errors" this package contributed were the parser failing, not findings.
 *
 * Same hole `packages/ui` and `backend/` were written to close; this is that
 * config minus the React blocks, since nothing here renders.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**"],
        react: false,
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
        },
        // Matching `packages/ui`, `apps/web`, `backend/` and the services: the
        // plugin's `unbound-method` rule needs type-aware parser services, and this
        // config is not type-aware — with the plugin on, eslint crashes rather than
        // reporting.
        vitest: false,
    },
    {
        // Source files only — `files: ["**/*"]` also matches `package.json` and
        // `tsconfig.json`, which eslint 10 parses as `jsonc/x`, and naming a
        // JS-only rule for an unsupported language is a hard error.
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * The calibration `backend/eslint.config.js` reached, applied here
             * too. That file carries the reasoning; duplicating it would only
             * create a second copy to drift.
             *
             * The four left at `warn` are judgement calls rather than defects —
             * a non-null assertion, an `any`, a complex function and a string
             * that looks like a secret are each sometimes the right answer.
             */
            "@typescript-eslint/explicit-member-accessibility": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-non-null-assertion": "warn",
            "antfu/if-newline": "off",
            "func-style": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "jsdoc/check-indentation": "off",
            "no-await-in-loop": "off",
            "no-secrets/no-secrets": "warn",
            "no-underscore-dangle": "off",
            "sonarjs/cognitive-complexity": "warn",
            "unicorn/consistent-boolean-name": "off",
            "unicorn/no-break-in-nested-loop": "off",
            "unicorn/no-null": "off",
            "unicorn/prefer-await": "off",
            "unicorn/prefer-simple-condition-first": "warn",
        },
    },
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        rules: {
            /**
             * `export type ImageSize = string` is a documenting alias consumed
             * from `apps/web` (5 files) and `backend`. Inlining `string`
             * everywhere is behaviour-identical and strictly less informative —
             * the same call already made for `ModelId` in `apps/web`.
             */
            "sonarjs/redundant-type-aliases": "off",
        },
    },
);
