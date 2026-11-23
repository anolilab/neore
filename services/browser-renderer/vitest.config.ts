import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            exclude: ["src/**/*.test.ts", "src/index.ts"],
            include: ["src/**/*.ts"],
            provider: "v8",
        },
        environment: "node",
        // `*.browser.test.ts` needs a local Chromium, which the unit-test job does not install: `test:browser` runs them.
        exclude: ["src/**/*.browser.test.ts"],
        include: ["src/**/*.test.ts"],
    },
});
