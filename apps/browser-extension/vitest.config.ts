import path from "node:path";

import { defineConfig } from "vitest/config";

import { timeSharding } from "../../scripts/vitest/time-sharding";

// Separate from vite.config.ts so tests do not boot the CRXJS manifest build.
export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "src"),
        },
    },
    test: {
        ...timeSharding(import.meta.url),
        environment: "jsdom",
        include: ["src/**/*.test.ts"],
    },
});
