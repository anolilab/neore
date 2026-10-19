import { createConfig } from "@anolilab/eslint-config";

/** @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer} */
export default createConfig({
    ignores: ["./dist/**", ".expo/**", "./web-build/**"],
    typescript: {
        ignoresTypeAware: ["*.json", "*.md"],
        isTypeAware: false,
        tsconfigPath: "./tsconfig.json",
    },
    vitest: false,
});
