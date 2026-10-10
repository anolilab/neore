import { createConfig } from "@anolilab/eslint-config";

/**
 * `packages/service-sdk` had no eslint config, so `eslint .` resolved up to the
 * repo-root `eslint.config.mjs`, which registers no TypeScript parser — every
 * `.ts` file failed to parse and no rule ever ran here.
 *
 * `src/generated/` is excluded for the same reason `.prettierignore` excludes
 * it: it is emitted from the service schemas, and linting a generator's output
 * only produces findings nobody can act on.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig({
    ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**", "./src/generated/**", "./scripts/**"],
    react: false,
    typescript: {
        ignoresTypeAware: ["*.json", "*.md"],
        isTypeAware: false,
        tsconfigPath: "./tsconfig.json",
    },
    vitest: false,
});
