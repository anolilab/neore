/**
 * The backend's data migrations (`defineMigration` in `backend/lunora/migrations.ts`), as `deploy.yml` runs them after
 * each deploy (`scripts/run-data-migrations.ts`). `lunora migrate up` takes one id and needs it, so the ids are read
 * from the source, in declaration order: a backfill that depends on an earlier one is declared after it.
 *
 * `backend/deploy-migrations.test.ts` pins that this list is every migration the module exports.
 */

/** The module that declares every data migration. Relative to the repository root. */
export const MIGRATIONS_MODULE = "backend/lunora/migrations.ts";

const DECLARATION = /defineMigration\(\{[^}]*?\bid:\s*"([^"]+)"/gu;

/** Every migration id declared in `source`, in declaration order. */
export const declaredMigrationIds = (source: string): string[] => [...source.matchAll(DECLARATION)].map((match) => match[1] as string);

/** What one `lunora migrate up <id> --format json` run reports. No shard keys, no rows: only counts. */
export interface MigrationRunSummary {
    changed: number;
    /** The CLI's own error, when it refused or could not reach the worker. It names the URL, so it is never printed in production. */
    error: string | undefined;
    exitCode: number;
    failedShards: number;
    okShards: number;
    /** Of the failed shards, those that did not answer in time (the run resumes there). */
    timedOutShards: number;
    processed: number;
    /** `completed`, `in_progress` or `failed`; `unknown` when the output could not be read. */
    status: string;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Reads the JSON the CLI writes to stdout with `--format json`: `{ code, data: { id, result }, error? }`, where `result`
 * is the worker's fan-out (`{ status, processed, changed, ok, failed, shards }`). The shards are dropped here.
 */
export const summarizeMigrationRun = (stdout: string, exitCode: number): MigrationRunSummary => {
    let parsed: { data?: { result?: Record<string, unknown> & { shards?: unknown } }; error?: unknown } | undefined;

    try {
        parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
        parsed = undefined;
    }

    const result = parsed?.data?.result;
    const shards = Array.isArray(result?.shards) ? (result.shards as { error?: { timedOut?: unknown } }[]) : [];

    return {
        changed: count(result?.changed),
        error: typeof parsed?.error === "string" ? parsed.error : undefined,
        exitCode,
        failedShards: count(result?.failed),
        okShards: count(result?.ok),
        processed: count(result?.processed),
        status: typeof result?.status === "string" ? result.status : "unknown",
        timedOutShards: shards.filter((shard) => shard.error?.timedOut === true).length,
    };
};

/** One log line: the id and counts only. */
export const formatMigrationRun = (id: string, summary: MigrationRunSummary): string =>
    `${id}: ${summary.status}, processed ${String(summary.processed)}, changed ${String(summary.changed)}, shards ok ${String(summary.okShards)} failed ${String(summary.failedShards)}, timed out ${String(summary.timedOutShards)} (exit ${String(summary.exitCode)})`;
