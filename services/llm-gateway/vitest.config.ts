import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // `src/index.ts` exports the `InternalApi` WorkerEntrypoint; Node has no
        // `cloudflare:workers` module, so suites get a minimal stand-in.
        alias: {
            "cloudflare:workers": fileURLToPath(new URL("src/__tests__/helpers/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: {
        coverage: {
            exclude: ["src/**/*.test.ts", "src/index.ts"],
            include: ["src/**/*.ts"],
            provider: "v8",
        },
        environment: "node",
        globals: true,
        include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
        // Vitest's default is 5s, which these integration tests exceed whenever
        // the monorepo suite runs them in parallel with everything else: they
        // spin up the Hono app and drive it through mocked providers. The
        // failures were never the same two tests twice, which is what gave the
        // flakiness away — in isolation all 46 pass well inside the default.
        testTimeout: 30_000,
    },
});
