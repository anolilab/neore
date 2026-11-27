import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { timeSharding } from "../../scripts/vitest/time-sharding";

export default defineConfig({
    // The app's `@/` imports (`tsconfig.json#paths`), so a test can render a screen as Metro builds it.
    resolve: {
        alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
    },
    test: {
        ...timeSharding(import.meta.url),
        environment: "node",
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        testTimeout: 10_000,
    },
});
