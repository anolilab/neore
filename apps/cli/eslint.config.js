import { createConfig } from "@anolilab/eslint-config";

/** @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer} */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**"],
        react: false,
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
        },
        // The vitest preset enables type-aware rules, which need `isTypeAware`;
        // `packages/service-sdk` and `services/llm-gateway` make the same trade.
        vitest: false,
    },
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        rules: {
            // The house-style calibrations `services/llm-gateway/eslint.config.js`
            // documents, for the same reasons: `null` is the wire value in the API
            // this client speaks; exports sit next to what they export; a CLI
            // polls and streams, so awaits in loops are the point.
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-non-null-assertion": "warn",
            "@typescript-eslint/no-restricted-types": "warn",
            "@typescript-eslint/no-use-before-define": ["error", { classes: true, enums: true, functions: false, typedefs: false, variables: false }],
            "func-style": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "max-classes-per-file": "off",
            // `fetch`, `ReadableStream` and `AbortSignal.any` are stable in every
            // Node the `engines` field allows (>=22.15 backports them).
            "n/no-unsupported-features/node-builtins": "off",
            "no-await-in-loop": "off",
            "no-bitwise": "off",
            "sonarjs/cognitive-complexity": "warn",
            "unicorn/no-break-in-nested-loop": "off",
            "unicorn/no-null": "off",
            "unicorn/no-top-level-side-effects": "off",
            "unicorn/prefer-await": "off",
        },
    },
);
