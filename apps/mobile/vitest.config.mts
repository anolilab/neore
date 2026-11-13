import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    // The app's `@/` imports (`tsconfig.json#paths`), so a test can render a screen as Metro builds it.
    resolve: {
        alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        testTimeout: 10_000,
    },
});
