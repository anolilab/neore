import { createConfig } from "@anolilab/eslint-config";

/**
 * `packages/chat-ui` had neither an eslint config nor a `lint:eslint` script, so
 * it was not merely unlinted — it was absent from the lint run entirely, and
 * nothing reported that.
 *
 * React settings mirror `packages/ui`, the other component tree.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**"],
        react: {
            reactCompiler: true,
            reactVersion: "19.2",
        },
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
        },
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
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * Prettier owns formatting in this repo — it runs in `lint:prettier`
             * and on commit, and it passes. These `@stylistic` rules disagree
             * with the output Prettier produces, so they are not findings anyone
             * can act on: "fixing" one means writing code Prettier immediately
             * reformats back.
             *
             * Verified rather than assumed, on
             * `chat/auto-continue-status.tsx:84` — `multiline-ternary` objects
             * to a JSX ternary that `prettier --check` calls correct.
             *
             * 135 of this package's findings were these eight rules.
             */
            "@stylistic/indent": "off",
            "@stylistic/indent-binary-ops": "off",
            "@stylistic/jsx-one-expression-per-line": "off",
            "@stylistic/jsx-wrap-multilines": "off",
            "@stylistic/multiline-ternary": "off",
            "@stylistic/no-extra-parens": "off",
            "@stylistic/operator-linebreak": "off",
        },
    },
);
