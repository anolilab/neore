import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

import { timeSharding } from "../../scripts/vitest/time-sharding";

export default defineConfig({
    resolve: {
        alias: {
            "@": resolve(__dirname, "src"),
            "~": resolve(__dirname, "src"),
            // `packages/ui` imports itself through this path (tsconfig `@ui/*`).
            "@ui": resolve(__dirname, "../../packages/ui/src"),
        },
    },
    test: {
        ...timeSharding(import.meta.url),
        environment: "jsdom",
        globals: true,
        include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.{ts,mjs}"],
        setupFiles: ["./vitest.setup.ts"],
        testTimeout: 10_000,
    },
});
