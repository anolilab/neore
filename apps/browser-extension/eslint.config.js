import { createConfig } from "@anolilab/eslint-config";

/**
 * The extension had neither an eslint config nor a `lint:eslint` script, so it
 * was the one app `pnpm lint` never covered.
 *
 * React settings and rule calibration mirror `packages/chat-ui`, whose source
 * this app compiles. Prettier owns formatting (`lint:prettier`), as everywhere
 * else in the repo.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**", "./dist-firefox/**", "./release/**", "./public/**"],
        react: {
            reactCompiler: true,
            reactVersion: "19.2",
        },
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.app.json",
        },
        // The vitest preset enables type-aware rules, which need `isTypeAware`;
        // `packages/chat-ui` and `apps/cli` make the same trade.
        vitest: false,
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        languageOptions: {
            // WebExtension APIs. Firefox also exposes `chrome.*`, which is the
            // only namespace this code uses (`src/lib/target.ts` picks behaviour
            // at build time, not by probing `browser`).
            globals: {
                chrome: "readonly",
            },
        },
        rules: {
            // The calibration `packages/chat-ui/eslint.config.js` carries (and
            // `backend/eslint.config.js` explains); duplicated here only as
            // rule names, not reasoning.
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

            /**
             * The rest is specific to an extension, each measured on this tree:
             *
             * `n/no-unsupported-features/*` — `fetch`, `Response`, `crypto`,
             * `navigator`, `Object.hasOwn`, `Array#toSorted`: web-platform APIs
             * checked against the Node >=16 the rule assumes with no `engines`
             * field. This code runs in Chrome 116+ / Firefox 140+ (the
             * manifest's minimums), and the two Vite configs in the repo's Node
             * 22+. Every finding was a false positive; `apps/web` and
             * `packages/ui` turn `node-builtins` off for the same reason.
             *
             * `no-void` as a statement is the fire-and-forget marker for a
             * promise, as in `apps/web` and the backend; `void` in an expression
             * stays an error.
             *
             * `react/function-component-definition` — components here are
             * hoisted `function` declarations, which is what lets `AuthPage`
             * sit above the two variants it picks between. Off in `packages/ui`
             * for the same hoisting reason; the matching
             * `no-use-before-define` calibration is `apps/cli`'s.
             *
             * `unicorn/no-top-level-assignment-in-function` — `use-models.ts`
             * and `access-token.ts` memoise a fetch in module scope, one per
             * panel lifetime; that IS the cache. The backend's config explains
             * the same pattern at length.
             *
             * `antfu/consistent-list-newline` — fires only on the tag and word
             * lists in `page-context/extract.ts`, which wrap by width; one
             * entry per line would make a 60-line selector list. Off in
             * `apps/web` and the backend too.
             */
            "@typescript-eslint/no-use-before-define": ["error", { classes: true, enums: true, functions: false, typedefs: false, variables: false }],
            "antfu/consistent-list-newline": "off",
            "n/no-unsupported-features/es-builtins": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "no-void": ["error", { allowAsStatement: true }],
            "react/function-component-definition": "off",
            "unicorn/no-top-level-assignment-in-function": "off",

            /**
             * Components are PascalCase files (`ChatPage.tsx`), everything else
             * kebab-case. Both are consistent; renaming the components would
             * only churn imports.
             */
            "unicorn/filename-case": ["error", { cases: { kebabCase: true, pascalCase: true } }],

            /**
             * Same demotion as `packages/ui` and `apps/web`. The two sites are
             * `ChatPage`'s seed effect, which also has to SEND the seed's quick
             * prompt — a side effect, so it cannot move into render.
             */
            "react-hooks/set-state-in-effect": "warn",
            "react-x/set-state-in-effect": "warn",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * Prettier owns formatting; these `@stylistic` rules disagree with
             * the output it produces, so "fixing" one means writing code Prettier
             * immediately reformats back. The same list `packages/chat-ui`
             * verified and turned off.
             */
            "@stylistic/indent": "off",
            "@stylistic/indent-binary-ops": "off",
            "@stylistic/jsx-one-expression-per-line": "off",
            "@stylistic/jsx-wrap-multilines": "off",
            "@stylistic/multiline-ternary": "off",
            "@stylistic/no-extra-parens": "off",
            "@stylistic/operator-linebreak": "off",
            // Prettier keeps single quotes around a string that holds double
            // quotes (`'{"alg":"EdDSA"}'`), since that needs fewer escapes;
            // `avoidEscape` is the same rule on the eslint side.
            "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
        },
    },
    {
        /**
         * Regex literals inside assertions (`toThrow(/cancelled/)`) run once per
         * test; hoisting each to module scope moves it away from the assertion
         * it documents.
         */
        files: ["**/*.test.ts"],
        rules: {
            "e18e/prefer-static-regex": "off",
        },
    },
    {
        /**
         * `index.css` is the Tailwind entry: the design system's import and
         * three lines of root sizing. A cascade layer would put that sizing
         * UNDER Tailwind's utilities. `packages/ui` and `apps/web` turn it off
         * for their entry sheets too.
         */
        files: ["**/*.css"],
        rules: {
            "css/use-layers": "off",
        },
    },
    {
        /**
         * TypeScript reads every tsconfig as JSONC, and the comments explain
         * why this app's options differ from the base config. Compiler option
         * names are not secrets.
         */
        files: ["tsconfig*.json"],
        rules: {
            "jsonc/no-comments": "off",
            "no-secrets/no-secrets": "off",
        },
    },
);
