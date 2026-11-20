import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { timeSharding } from "../../scripts/vitest/time-sharding";

export default defineConfig({
    resolve: {
        alias: {
            "@ui": fileURLToPath(new URL("src", import.meta.url)),
        },
    },
    test: {
        ...timeSharding(import.meta.url),
        globals: true,
        include: ["src/**/*.{test,spec}.{ts,tsx}"],
        // A loaded CI runner can take far longer than a laptop for a test that does almost nothing.
        testTimeout: 30_000,
    },
});
