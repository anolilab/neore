import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The backend ran on Vitest defaults until it needed a stand-in for
 * `cloudflare:workers` (a workerd built-in Node cannot resolve), and then a
 * harness that matches production's `ctx.db` (`test/setup-harness.ts`).
 * Everything else is deliberately left at the default.
 */
export default defineConfig({
    resolve: {
        alias: {
            // `fileURLToPath`, not `.pathname`: the latter yields "/C:/…" on Windows.
            "cloudflare:workers": fileURLToPath(new URL("test/stubs/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: {
        setupFiles: ["test/setup-harness.ts"],
    },
});
