import { defineConfig } from "vitest/config";

/** The saved-login fill against a local Chromium (`pnpm exec playwright install chromium`) and local test sites. */
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.browser.test.ts"],
        // Each case launches pages and waits on a real browser: far past Vitest's 5s default.
        testTimeout: 60_000,
    },
});
