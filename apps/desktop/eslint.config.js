import { createConfig } from "@anolilab/eslint-config";

const config = await createConfig({
    ignores: ["./src/acp/testing/fake-agent.mjs", "./dist/**", "./release/**", "./test-results/**", "./playwright-report/**", "./.eslint.cache.json", "./electron-builder.yml"],
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
        // An Electron app keeps `electron` (and the toolchain) as devDependencies by convention. esbuild bundles
        // every devDependency into dist/, and only `electron` and `electron-updater` stay external.
        files: ["src/**/*.ts", "e2e/**/*.ts"],
        name: "neore/desktop/devDependencies",
        rules: {
            "import/no-extraneous-dependencies": ["error", { devDependencies: true }],
        },
    },
    {
        // The same house calibration as apps/mobile: exports sit where the code reads best, a module may have
        // several named exports and no default, and return types are not written.
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        name: "neore/desktop/calibration",
        rules: {
            "@typescript-eslint/explicit-module-boundary-types": "off",
            // A closure runs after module init, so it may reference a const declared further down the file.
            "@typescript-eslint/no-use-before-define": ["error", { functions: false, variables: false }],
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            // A conditional arrow body is the clearest form for the one-line selectors in this app; parentheses around
            // it conflict with no-extra-parens, and a block body conflicts with arrow-body-style.
            "no-confusing-arrow": "off",
            // Boolean functions name a capability or an action (`supportsBadge`, `registerDeviceIpc`), not a predicate prefix.
            "unicorn/consistent-boolean-name": "off",
            // Two rules that order class members in opposite ways (private first, public first); the TypeScript one
            // stays, and a class reads top-down from its public methods.
            "unicorn/consistent-class-member-order": "off",
        },
    },
    {
        // `null` is the absent value in IPC payloads and persisted window state; the codebase uses it on purpose.
        files: ["src/**/*.ts", "e2e/**/*.ts"],
        name: "neore/desktop/boundary",
        rules: {
            // IPC payloads and the saved settings patch are open records, and the validators read them key by key.
            "@typescript-eslint/no-restricted-types": "off",
            "unicorn/no-null": "off",
        },
    },
    {
        // The package declares no `engines`, so the linter assumes Node 16. The app runs on Electron's Node 22+ and the page
        // script on Chromium, which have `fetch`, `Response`, `navigator`, `DOMException`, `Array#at`.
        files: ["src/dictation/**/*.ts", "e2e/dictation.spec.ts"],
        name: "neore/desktop/dictation-runtime",
        rules: {
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
        },
    },
    {
        // Tests mock `electron`, which only exists inside the Electron runtime, so a module mock is the only seam.
        // Their fixtures include PKCE vectors and accelerator strings that look like secrets to the entropy check.
        files: ["**/*.test.ts", "e2e/**/*.ts"],
        name: "neore/desktop/tests",
        rules: {
            "no-restricted-syntax": "off",
            "no-secrets/no-secrets": "off",
            // Each test resets the shared fakes and the core it reads in `beforeEach`.
            "unicorn/no-top-level-assignment-in-function": "off",
        },
    },
    {
        // The dictation tests walk folders and files in order and read a result before they assert on it, and they make
        // scratch folders under the OS temp folder on purpose (the helper's TMPDIR points at one).
        files: ["src/dictation/**/*.test.ts", "e2e/dictation.spec.ts"],
        name: "neore/desktop/dictation-tests",
        rules: {
            "no-await-in-loop": "off",
            "sonarjs/publicly-writable-directories": "off",
            "unicorn/no-await-expression-member": "off",
        },
    },
];
