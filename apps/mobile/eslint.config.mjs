import { createConfig } from "@anolilab/eslint-config";

/** @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer} */
const config = await createConfig({
    ignores: ["./dist/**", ".expo/**", "./web-build/**"],
    typescript: {
        ignoresTypeAware: ["*.json", "*.md"],
        isTypeAware: false,
        tsconfigPath: "./tsconfig.json",
    },
    vitest: false,
});

export default [
    ...config,
    {
        // The same calibration `apps/web` and `apps/desktop` use, applied here. Each is a house-style
        // choice, not a defect: exports sit where the code reads best, and return types are not written.
        // `n/no-unsupported-features/node-builtins` checks Node support for browser globals (`fetch`,
        // `ReadableStream`); Hermes is the runtime, not Node. Modules here export one named helper
        // each (the auth and lib files), which is the codebase's convention, not a missing default.
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        name: "neore/mobile/calibration",
        rules: {
            // Prettier writes a string holding `"` in single quotes rather than escaping it; `avoidEscape` accepts that.
            "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "n/no-unsupported-features/node-builtins": "off",
        },
    },
    {
        // expo-router: the file name is the route param (`[threadId]` is read as `threadId`), and each route
        // must default-export its screen. Renaming or un-defaulting either breaks navigation.
        files: ["app/**/*.{ts,tsx}"],
        name: "neore/mobile/routes",
        rules: {
            "unicorn/filename-case": "off",
        },
    },
    {
        // Metro loads this file as CommonJS, so `require()` is the correct form here.
        files: ["metro.config.js"],
        name: "neore/mobile/metro",
        rules: {
            "@typescript-eslint/no-require-imports": "off",
        },
    },
    {
        // Key order in package.json is `sort-package-json`'s (the root `sort-package-json` script writes it), which
        // puts `android` before `build`. `jsonc/sort-keys` wants `build` first. Both cannot hold, so the formatter wins.
        files: ["package.json"],
        name: "neore/mobile/package-json",
        rules: {
            "jsonc/sort-keys": "off",
        },
    },
    {
        // Fixed PKCE verifiers, state values and redirect URLs are high-entropy by construction. `null` is the
        // signed-out value of `GrantStore`, so fakes of that store and the fixtures around it use it too.
        files: ["**/*.test.{ts,tsx}"],
        name: "neore/mobile/tests",
        rules: {
            "no-secrets/no-secrets": "off",
            "unicorn/no-null": "off",
        },
    },
];
