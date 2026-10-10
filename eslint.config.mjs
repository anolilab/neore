import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Root-level TypeScript that belongs to no workspace project, so no project's
 * own eslint config reaches it. `alchemy.run.ts` runs under `tsx`, which strips
 * types without checking them; `tsconfig.deploy.json` is the program both this
 * and `pnpm lint:types:deploy` type-check it with.
 */
const DEPLOY_FILES = ["alchemy.run.ts", "scripts/worker-bundle.ts"];

export default [
    {
        files: ["**/*.json"],
        // Override or add rules here
        rules: {},
        languageOptions: {
            parser: await import("jsonc-eslint-parser"),
        },
    },
    {
        ignores: [
            "**/dist",
            "**/vite.config.*.timestamp*",
            "**/vitest.config.*.timestamp*",
            // Codegen output. `backend/eslint.config.js` ignores it too, and the
            // per-project run is what `pnpm lint:eslint` (`vis run lint:eslint`)
            // uses — but a root-level `eslint .` bypasses that config entirely and
            // would lint `_generated/**`, where a fix cannot survive: the next
            // `pnpm codegen` overwrites the file.
            "**/_generated/**",
            "**/.lunora-schema.json",
        ],
    },
    {
        files: ["**/*.ts", "**/*.tsx", "**/*.cts", "**/*.mts", "**/*.js", "**/*.jsx", "**/*.cjs", "**/*.mjs"],
        // Override or add rules here
        rules: {},
    },
    ...[js.configs.recommended, ...tseslint.configs.recommendedTypeChecked].map((config) => ({ ...config, files: DEPLOY_FILES })),
    {
        files: DEPLOY_FILES,
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.deploy.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
];
