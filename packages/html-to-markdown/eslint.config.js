import { createConfig } from "@anolilab/eslint-config";

/**
 * Same shape as `packages/ai/eslint.config.js`: a TypeScript config without
 * React. Without a config here `eslint .` would resolve to the root config,
 * which registers no TypeScript parser.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**", "./test/fixtures/**"],
        react: false,
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
        },
        vitest: false,
    },
    {
        // Tests and the benchmark run from the workspace and import the devDependencies they use.
        files: ["bench/**/*.ts", "test/**/*.ts"],
        rules: {
            "import/no-extraneous-dependencies": ["error", { devDependencies: true }],
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            // The converter is one module with mutually recursive function
            // declarations (process <-> replacementForNode), as upstream has it.
            "@typescript-eslint/no-use-before-define": ["error", { functions: false }],
            "@typescript-eslint/explicit-member-accessibility": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "antfu/if-newline": "off",
            "func-style": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "jsdoc/check-indentation": "off",
            "jsdoc/text-escaping": "off",
            "no-await-in-loop": "off",
            "no-underscore-dangle": "off",
            "unicorn/no-null": "off",
            "unicorn/prefer-await": "off",
        },
    },
);
