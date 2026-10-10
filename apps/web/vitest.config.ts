import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

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
        environment: "jsdom",
        globals: true,
        include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.{ts,mjs}"],
        setupFiles: ["./vitest.setup.ts"],
        testTimeout: 10_000,
    },
});
