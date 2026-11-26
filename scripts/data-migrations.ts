/**
 * The backend's data migrations (`defineMigration` in `backend/lunora/migrations.ts`), as `deploy.yml` runs them after
 * each deploy (`scripts/run-data-migrations.ts`). `lunora migrate up` takes one id and needs it, so the ids are read
 * from the source, in declaration order: a backfill that depends on an earlier one is declared after it.
 *
 * `backend/deploy-migrations.test.ts` pins that this list is every migration the module exports.
 */

import ts from "typescript";

/** The module that declares every data migration. Relative to the repository root. */
export const MIGRATIONS_MODULE = "backend/lunora/migrations.ts";

/** The committed schema baseline (`lunora prepare`), which records each table's shard mode. Relative to the repository root. */
export const SCHEMA_BASELINE = "backend/lunora/.lunora-schema.json";

/** How often one migration runs while it stays `in_progress`, and the pause between those runs. */
export const MIGRATION_ATTEMPTS = 4;
const MIGRATION_PAUSE_MS = 15_000;

const literalText = (node: ts.Node | undefined): string | undefined =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/** The literal string value of the `name` property of `call`'s first argument. */
const definitionProperty = (call: ts.CallExpression, name: string): string | undefined => {
    const [definition] = call.arguments;
    const property =
        definition !== undefined && ts.isObjectLiteralExpression(definition)
            ? definition.properties.find(
                  (member) => member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === name,
              )
            : undefined;

    return property !== undefined && ts.isPropertyAssignment(property) ? literalText(property.initializer) : undefined;
};

const migrationId = (call: ts.CallExpression, file: ts.SourceFile, globalTables: ReadonlySet<string>): string => {
    const id = definitionProperty(call, "id");
    const { line } = file.getLineAndCharacterOfPosition(call.getStart(file));
    const at = `${MIGRATIONS_MODULE}:${String(line + 1)}`;

    if (id === undefined) {
        throw new Error(`${at}: defineMigration needs a literal string \`id\` so the deploy can run it`);
    }

    const table = definitionProperty(call, "table");

    if (table !== undefined && globalTables.has(table)) {
        throw new Error(
            `${at}: migration "${id}" targets the .global() table "${table}", which defineMigration never reaches (it runs in the shard Durable Objects, not D1); backfill it through D1 instead`,
        );
    }

    return id;
};

/** The tables `baseline` (the committed `.lunora-schema.json`) records as `.global()`, on any backend. */
export const globalTablesOf = (baseline: string): Set<string> => {
    const { tables } = JSON.parse(baseline) as { tables?: Record<string, { shardMode?: unknown }> };

    return new Set(
        Object.entries(tables ?? {})
            .filter(([, table]) => typeof table.shardMode === "string" && table.shardMode.startsWith("global"))
            .map(([name]) => name),
    );
};

/**
 * Every migration id declared in `source`, in declaration order. Throws when a `defineMigration` call's `id` is not a
 * literal string (a partial list would skip that migration on deploy), and when one targets a table in `globalTables`: a
 * shard migration does not reach a `.global()` table's rows, and its run fails on the root shard, stopping every
 * migration after it.
 */
export const declaredMigrationIds = (source: string, globalTables: ReadonlySet<string> = new Set()): string[] => {
    const file = ts.createSourceFile(MIGRATIONS_MODULE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const ids: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineMigration") {
            ids.push(migrationId(node, file, globalTables));
        }

        ts.forEachChild(node, visit);
    };

    visit(file);

    return ids;
};

/** What one `lunora migrate up <id> --format json` run reports. No shard keys, no rows: only counts. */
export interface MigrationRunSummary {
    changed: number;
    /** The CLI's own error, when it refused or could not reach the worker. It names the URL, so it is never printed in production. */
    error: string | undefined;
    /** The worker's refusal (`data.result.error`), e.g. `FORBIDDEN`. Its code names no URL and no row. */
    resultErrorCode: string | undefined;
    /** That refusal's message; printed outside production only. */
    resultErrorMessage: string | undefined;
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
    const resultError = (result?.error ?? undefined) as { code?: unknown; message?: unknown } | undefined;
    const shards = Array.isArray(result?.shards) ? (result.shards as { error?: { timedOut?: unknown } }[]) : [];

    return {
        changed: count(result?.changed),
        error: typeof parsed?.error === "string" ? parsed.error : undefined,
        exitCode,
        failedShards: count(result?.failed),
        okShards: count(result?.ok),
        processed: count(result?.processed),
        resultErrorCode: typeof resultError?.code === "string" ? resultError.code : undefined,
        resultErrorMessage: typeof resultError?.message === "string" ? resultError.message : undefined,
        status: typeof result?.status === "string" ? result.status : "unknown",
        timedOutShards: shards.filter((shard) => shard.error?.timedOut === true).length,
    };
};

/** One log line: the id and counts only. */
export const formatMigrationRun = (id: string, summary: MigrationRunSummary): string =>
    `${id}: ${summary.status}, processed ${String(summary.processed)}, changed ${String(summary.changed)}, shards ok ${String(summary.okShards)} failed ${String(summary.failedShards)}, timed out ${String(summary.timedOutShards)} (exit ${String(summary.exitCode)})`;

/** One finished CLI process: what `spawnSync` returns, narrowed to what the runner reads. */
export interface CliRun {
    /** Set when the CLI did not run (ENOENT) or its output was cut off (ENOBUFS). */
    error?: Error | undefined;
    status: number | null;
    /** The CLI's log; it names the request URL, so only its redacted tail is printed, and never in production. */
    stderr?: string | null;
    stdout: string | null;
}

/** How many of the CLI's last stderr lines a failure prints outside production. */
const STDERR_TAIL_LINES = 15;

/** The last lines of the CLI's log with every URL replaced, so a host or query string never reaches the public log. */
export const redactedStderrTail = (stderr: string): string[] =>
    stderr
        .split("\n")
        .map((line) => line.replaceAll(/https?:\/\/[^\s"'<>]*[^\s"'<>:,.;)]/gu, "<url>").trimEnd())
        .filter((line) => line !== "")
        .slice(-STDERR_TAIL_LINES);

export interface RunMigrationsOptions {
    error: (line: string) => void;
    log: (line: string) => void;
    /** Production prints no CLI error detail: it names the URL. */
    production: boolean;
    run: (id: string) => CliRun;
    sleep: (ms: number) => Promise<unknown>;
}

/**
 * Runs each migration in order. One that stays `in_progress` is retried after a pause, up to `MIGRATION_ATTEMPTS` runs; `failed`,
 * unreadable output, or running out of attempts stops the job before the next id. Returns the process exit code.
 */
export const runDataMigrations = async (ids: readonly string[], options: RunMigrationsOptions): Promise<number> => {
    for (const id of ids) {
        let line = "";
        let ok = false;

        for (let attempt = 1; attempt <= MIGRATION_ATTEMPTS && !ok; attempt += 1) {
            const run = options.run(id);
            const summary = summarizeMigrationRun(run.stdout ?? "", run.status ?? 1);

            line = formatMigrationRun(id, summary);
            options.log(attempt === 1 ? line : `${line} [attempt ${String(attempt)}]`);

            if (run.error !== undefined) {
                options.log(`  could not run the CLI: ${(run.error as NodeJS.ErrnoException).code ?? run.error.name}`);
            }

            if (summary.exitCode === 0 && summary.status === "completed") {
                ok = true;
            } else if (summary.status === "in_progress" && attempt < MIGRATION_ATTEMPTS) {
                await options.sleep(MIGRATION_PAUSE_MS);
            } else {
                if (summary.resultErrorCode !== undefined) {
                    options.log(
                        options.production || summary.resultErrorMessage === undefined
                            ? `  worker refused: ${summary.resultErrorCode}`
                            : `  worker refused: ${summary.resultErrorCode}: ${summary.resultErrorMessage}`,
                    );
                }

                if (!options.production && summary.error !== undefined) {
                    options.log(`  ${summary.error}`);
                }

                // A CLI that failed before writing JSON says why only on stderr.
                if (!options.production && run.stderr) {
                    for (const tail of redactedStderrTail(run.stderr)) {
                        options.log(`  | ${tail}`);
                    }
                }

                break;
            }
        }

        if (!ok) {
            // Order matters (a later backfill can read an earlier one's result), so stop at the first that did not finish.
            options.error(`::error::data migration ${line}`);

            return 1;
        }
    }

    return 0;
};

/** The backfill of `user.emailCanonical`, which the deploy runs through D1 (`backend/lunora/auth/email-canonical-backfill.ts`). */
export const EMAIL_CANONICAL_BACKFILL = "backfill-email-canonical";

/** Calls one run of the backfill may make; each fills one batch. */
export const EMAIL_CANONICAL_MAX_CALLS = 2000;

/** The longest `retry-after` the runner waits out; a longer one fails the step. */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

/** One call of `POST /admin/backfill-email-canonical`: its HTTP status, its JSON body (or `undefined`) and `retry-after`. */
export interface BackfillCall {
    body: unknown;
    retryAfterSeconds?: number | undefined;
    status: number;
}

export interface RunBackfillOptions {
    call: () => Promise<BackfillCall>;
    error: (line: string) => void;
    log: (line: string) => void;
    maxCalls?: number;
    sleep: (ms: number) => Promise<unknown>;
}

const backfillBody = (body: unknown): { conflicts: number; filled: number; remaining: number; status: string } => {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    return {
        conflicts: count(record.conflicts),
        filled: count(record.filled),
        remaining: count(record.remaining),
        status: typeof record.status === "string" ? record.status : "unknown",
    };
};

/**
 * Calls the backfill until it answers `done`. Stops with an error on a conflict (two accounts that fold to one address), on
 * a call that makes no progress, on any other answer, or after `maxCalls`. A 429 is waited out. Prints counts only.
 * Returns the process exit code.
 */
export const runEmailCanonicalBackfill = async (options: RunBackfillOptions): Promise<number> => {
    const maxCalls = options.maxCalls ?? EMAIL_CANONICAL_MAX_CALLS;
    let filled = 0;
    let calls = 0;

    const fail = (reason: string): number => {
        options.error(`::error::${EMAIL_CANONICAL_BACKFILL}: ${reason} (filled ${String(filled)} over ${String(calls)} call(s))`);

        return 1;
    };

    while (calls < maxCalls) {
        let answer: BackfillCall;

        calls += 1;

        try {
            answer = await options.call();
        } catch (error) {
            // A fetch error names the URL in its cause, never in its name.
            return fail(`the request failed (${error instanceof Error ? error.name : "error"})`);
        }

        if (answer.status === 429) {
            const waitMs = (answer.retryAfterSeconds ?? 60) * 1000;

            if (waitMs > MAX_RETRY_AFTER_MS) {
                return fail(`rate limited for ${String(answer.retryAfterSeconds)}s`);
            }

            options.log(`${EMAIL_CANONICAL_BACKFILL}: rate limited, waiting ${String(waitMs / 1000)}s`);
            await options.sleep(waitMs);
            continue;
        }

        const body = backfillBody(answer.body);

        filled += body.filled;

        if (answer.status === 409 || body.status === "conflict") {
            return fail(
                `${String(body.conflicts)} address(es) belong to more than one account once case and Unicode form are ignored; merge or rename them, then deploy again`,
            );
        }

        if (answer.status !== 200) {
            return fail(`answered HTTP ${String(answer.status)}`);
        }

        if (body.status === "done") {
            options.log(`${EMAIL_CANONICAL_BACKFILL}: done, filled ${String(filled)} over ${String(calls)} call(s)`);

            return 0;
        }

        if (body.status !== "progress" || body.filled === 0) {
            return fail(`made no progress (${body.status}, ${String(body.remaining)} left)`);
        }
    }

    return fail(`not done after ${String(maxCalls)} calls`);
};
