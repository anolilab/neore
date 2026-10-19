import { createConfig } from "@anolilab/eslint-config";

const config = await createConfig({
    ignores: ["./dist/**", "./release/**", "./test-results/**", "./playwright-report/**", "./.eslint.cache.json"],
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
];
