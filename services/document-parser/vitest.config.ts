import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        // workerd boots the 14 MiB module once per suite; a cold start under a
        // parallel monorepo run takes several seconds.
        hookTimeout: 120_000,
        include: ["test/**/*.test.ts"],
        testTimeout: 60_000,
    },
});
