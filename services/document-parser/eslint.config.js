import { createConfig } from "@anolilab/eslint-config";

/** @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer} */
export default createConfig({
    // The Worker itself is Rust (`src/`); only the build script and the workerd suite are JS/TS.
    ignores: ["./eslint.config.js", "./.eslint.cache.json", "./build/**", "./target/**", "./.wrangler/**"],
    // As in services/llm-gateway: the vitest plugin's `unbound-method` needs
    // type-aware parser services, and this config is not type-aware.
    vitest: false,
    typescript: {
        isTypeAware: false,
        tsconfigPath: "./tsconfig.json",
        ignoresTypeAware: ["*.json", "*.md"],
    },
});
