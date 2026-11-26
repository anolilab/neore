/**
 * Runs every data migration the backend declares against the deployed backend, in declaration order (`deploy.yml`, after
 * the smoke test). `lunora migrate up` is idempotent and resumable: a migration a shard has completed returns at once,
 * so each deploy runs only what is new.
 *
 * Reads `BACKEND_URL` and `STAGE`; the CLI reads the admin token from `LUNORA_ADMIN_TOKEN` (never `--token`, which the
 * process table shows). The run log is public, so only ids and counts are printed: the CLI's own output (shard keys,
 * per-shard results, the request URL) is captured and dropped. A failure prints the worker's refusal code; outside
 * production also its message and the last lines of the CLI's stderr with every URL replaced. Production prints no more.
 *
 * A run stays `in_progress` when a shard did not finish or did not answer in time (the CLI then exits non-zero too). It
 * resumes from each shard's cursor, so it is retried after a pause. `failed`, or output that cannot be read, stops the
 * job at once.
 *
 * First it fills `user.emailCanonical` through D1 (`POST /admin/backfill-email-canonical`): a check of every account, page
 * by page, that no address is shared by two, then the fill, one batch per call, then a check again until it is done. The
 * cursors and the check's digests travel only in the request and response bodies, never in the log. `user` is a
 * `.global()` table, which `lunora migrate up` does not reach. The backfill and the shard migrations are
 * independent, so each runs whether or not the other fails; the job fails if either does. A migration declared on a
 * `.global()` table fails the step before anything runs.
 *
 * Run: pnpm exec tsx scripts/run-data-migrations.ts
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { declaredMigrationIds, globalTablesOf, MIGRATIONS_MODULE, runDataMigrations, runEmailCanonicalBackfill, SCHEMA_BASELINE } from "./data-migrations";

/** The CLI pretty-prints every shard's outcome to stdout. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** How long one backfill call may take; it sends at most 50 D1 statements. */
const BACKFILL_CALL_TIMEOUT_MS = 60_000;

const backendUrl = process.env.BACKEND_URL ?? "";

if (backendUrl === "" || (process.env.LUNORA_ADMIN_TOKEN ?? "") === "") {
    console.error("::error::BACKEND_URL and LUNORA_ADMIN_TOKEN must both be set");
    process.exit(1);
}

const backend = join(import.meta.dirname, "..", "backend");
let ids: string[];

try {
    ids = declaredMigrationIds(
        readFileSync(join(import.meta.dirname, "..", MIGRATIONS_MODULE), "utf8"),
        globalTablesOf(readFileSync(join(import.meta.dirname, "..", SCHEMA_BASELINE), "utf8")),
    );
} catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const backfilled = await runEmailCanonicalBackfill({
    call: async (request) => {
        const response = await fetch(new URL("/admin/backfill-email-canonical", backendUrl), {
            body: JSON.stringify(request),
            headers: { authorization: `Bearer ${process.env.LUNORA_ADMIN_TOKEN ?? ""}`, "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(BACKFILL_CALL_TIMEOUT_MS),
        });
        const retryAfter = Number(response.headers.get("retry-after"));

        const text = await response.text().catch(() => "");
        let body: unknown;

        try {
            body = JSON.parse(text);
        } catch {
            // A refusal that is not JSON still says why; the runner prints it outside production only.
            body = text === "" ? undefined : { message: text };
        }

        return {
            body,
            retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
            status: response.status,
        };
    },
    error: console.error,
    log: console.log,
    production: process.env.STAGE === "production",
    salt: () => randomBytes(16).toString("hex"),
    sleep,
});

console.log(`running ${String(ids.length)} data migration(s)`);

const migrated = await runDataMigrations(ids, {
    error: console.error,
    log: console.log,
    production: process.env.STAGE === "production",
    run: (id) =>
        spawnSync(join(backend, "node_modules/.bin/lunora"), ["migrate", "up", id, "--prod", "--yes", "--url", backendUrl, "--format", "json"], {
            cwd: backend,
            encoding: "utf8",
            env: process.env,
            maxBuffer: MAX_OUTPUT_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
        }),
    sleep,
});

process.exitCode = backfilled === 0 && migrated === 0 ? 0 : 1;
