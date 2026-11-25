/**
 * Runs every data migration the backend declares against the deployed backend, in declaration order (`deploy.yml`, after
 * the smoke test). `lunora migrate up` is idempotent and resumable: a migration a shard has completed returns at once,
 * so each deploy runs only what is new.
 *
 * Reads `BACKEND_URL` and `STAGE`; the CLI reads the admin token from `LUNORA_ADMIN_TOKEN` (never `--token`, which the
 * process table shows). The run log is public, so only ids and counts are printed: the CLI's own output (shard keys,
 * per-shard results, the request URL) is captured and dropped. Outside production a failure also prints the CLI's
 * own error (a refusal, an unreachable worker), which names the URL; production prints none.
 *
 * A run stays `in_progress` when a shard did not finish or did not answer in time (the CLI then exits non-zero too). It
 * resumes from each shard's cursor, so it is retried after a pause. `failed`, or output that cannot be read, stops the
 * job at once.
 *
 * Run: pnpm exec tsx scripts/run-data-migrations.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { declaredMigrationIds, formatMigrationRun, MIGRATIONS_MODULE, summarizeMigrationRun } from "./data-migrations";

const ATTEMPTS = 4;
const PAUSE_MS = 15_000;
/** The CLI pretty-prints every shard's outcome to stdout. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const backendUrl = process.env.BACKEND_URL ?? "";
const production = process.env.STAGE === "production";

if (backendUrl === "" || (process.env.LUNORA_ADMIN_TOKEN ?? "") === "") {
    console.error("::error::BACKEND_URL and LUNORA_ADMIN_TOKEN must both be set");
    process.exit(1);
}

const backend = join(import.meta.dirname, "..", "backend");
const ids = declaredMigrationIds(readFileSync(join(import.meta.dirname, "..", MIGRATIONS_MODULE), "utf8"));

console.log(`running ${String(ids.length)} data migration(s)`);

for (const id of ids) {
    let line = "";
    let ok = false;

    for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt += 1) {
        const run = spawnSync(join(backend, "node_modules/.bin/lunora"), ["migrate", "up", id, "--prod", "--yes", "--url", backendUrl, "--format", "json"], {
            cwd: backend,
            encoding: "utf8",
            env: process.env,
            maxBuffer: MAX_OUTPUT_BYTES,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const summary = summarizeMigrationRun(run.stdout ?? "", run.status ?? 1);

        line = formatMigrationRun(id, summary);
        console.log(attempt === 1 ? line : `${line} [attempt ${String(attempt)}]`);

        if (run.error !== undefined) {
            // ENOENT, ENOBUFS: the CLI did not run, or its output was cut off.
            console.log(`  could not run the CLI: ${(run.error as NodeJS.ErrnoException).code ?? run.error.name}`);
        }

        if (summary.exitCode === 0 && summary.status === "completed") {
            ok = true;
        } else if (summary.status === "in_progress" && attempt < ATTEMPTS) {
            await sleep(PAUSE_MS);
        } else {
            if (!production && summary.error !== undefined) {
                console.log(`  ${summary.error}`);
            }

            break;
        }
    }

    if (!ok) {
        // Order matters (a later backfill can read an earlier one's result), so stop at the first that did not finish.
        console.error(`::error::data migration ${line}`);
        process.exit(1);
    }
}
