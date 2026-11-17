import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

/**
 * The backend ran on Vitest defaults until it needed a stand-in for
 * `cloudflare:workers` (a workerd built-in Node cannot resolve), and then a
 * harness that matches production's `ctx.db` (`test/setup-harness.ts`).
 * Everything else is deliberately left at the default.
 *
 * Files in {@link SERIAL_FILES} seed fixtures large enough that they exceed the
 * hook timeout when they share the machine with the rest of the suite. They run
 * alone, after the parallel group has finished (`sequence.groupOrder`).
 */
const SERIAL_FILES = ["lunora/admin/shard-footprint.test.ts"];

export default defineConfig({
    resolve: {
        alias: {
            // `fileURLToPath`, not `.pathname`: the latter yields "/C:/…" on Windows.
            "cloudflare:workers": fileURLToPath(new URL("test/stubs/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: {
        projects: [
            {
                extends: true,
                test: {
                    exclude: [...configDefaults.exclude, ...SERIAL_FILES],
                    name: "parallel",
                    sequence: { groupOrder: 1 },
                },
            },
            {
                extends: true,
                test: {
                    fileParallelism: false,
                    include: SERIAL_FILES,
                    name: "serial",
                    sequence: { groupOrder: 2 },
                },
            },
        ],
        setupFiles: ["test/setup-harness.ts"],
    },
});
