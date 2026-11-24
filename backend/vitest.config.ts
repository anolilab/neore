import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

import { timeSharding } from "../scripts/vitest/time-sharding";

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
// `browser/gdpr.test.ts` writes and reads 40 MB of typed actions to pass the transaction's 32 MiB read limit.
const SERIAL_FILES = ["lunora/admin/shard-footprint.test.ts", "lunora/browser/gdpr.test.ts"];

/**
 * Tests that pass alone and fail only when the whole suite shares the machine (timing, or fixtures that compete for CPU). They run in
 * their own project with two retries: a retry that passes is reported as flaky, so the flakiness stays visible, and a test that fails on
 * every attempt still fails the run. Move a file out of this list once its cause is fixed.
 */
const QUARANTINED_FILES = [
    "lunora/acp/gdpr.test.ts",
    "lunora/acp/switch.test.ts",
    "lunora/chat/lib/approval-reminder.test.ts",
    "lunora/chat/lib/link-preview.test.ts",
    "lunora/sub-agents/approvals.test.ts",
];

export default defineConfig({
    resolve: {
        alias: {
            // `fileURLToPath`, not `.pathname`: the latter yields "/C:/…" on Windows.
            "cloudflare:sockets": fileURLToPath(new URL("test/stubs/cloudflare-sockets.ts", import.meta.url)),
            "cloudflare:workers": fileURLToPath(new URL("test/stubs/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: {
        ...timeSharding(import.meta.url),
        projects: [
            {
                extends: true,
                test: {
                    exclude: [...configDefaults.exclude, ...SERIAL_FILES, ...QUARANTINED_FILES],
                    name: "parallel",
                    sequence: { groupOrder: 1 },
                },
            },
            {
                extends: true,
                test: {
                    include: QUARANTINED_FILES,
                    name: "quarantined",
                    retry: 2,
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
