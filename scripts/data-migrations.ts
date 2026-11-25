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

/** `node` without the `as`, `satisfies` and parentheses around it. */
const unwrapped = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ? unwrapped(node.expression) : node;

/** The module's top-level `const NAME = "literal"` declarations, which a `table` may name. */
const constStrings = (file: ts.SourceFile): Map<string, string> => {
    const found = new Map<string, string>();

    for (const statement of file.statements) {
        if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
            for (const declaration of statement.declarationList.declarations) {
                const value = declaration.initializer === undefined ? undefined : literalText(unwrapped(declaration.initializer));

                if (ts.isIdentifier(declaration.name) && value !== undefined) {
                    found.set(declaration.name.text, value);
                }
            }
        }
    }

    return found;
};

/** A literal string, or a top-level string constant named by `node`. */
const resolvedText = (node: ts.Expression, constants: ReadonlyMap<string, string>): string | undefined => {
    const bare = unwrapped(node);

    return literalText(bare) ?? (ts.isIdentifier(bare) ? constants.get(bare.text) : undefined);
};

/** What a definition says about one property: not there, a string the runner can read, or something it cannot. */
type PropertyValue = { kind: "absent" } | { kind: "string"; value: string } | { kind: "unresolved" };

const UNRESOLVED: PropertyValue = { kind: "unresolved" };

/**
 * The value of the `name` property of `call`'s first argument. `literalOnly` refuses a constant. A spread, a computed key
 * the runner cannot read, or a definition that is not an object literal could hide the property: unresolved.
 */
const definitionProperty = (call: ts.CallExpression, name: string, constants: ReadonlyMap<string, string>, literalOnly: boolean): PropertyValue => {
    const [definition] = call.arguments;
    const read = (node: ts.Expression): PropertyValue => {
        const value = literalOnly ? literalText(node) : resolvedText(node, constants);

        return value === undefined ? UNRESOLVED : { kind: "string", value };
    };

    if (definition === undefined || !ts.isObjectLiteralExpression(unwrapped(definition))) {
        return UNRESOLVED;
    }

    let found: PropertyValue = { kind: "absent" };

    for (const member of (unwrapped(definition) as ts.ObjectLiteralExpression).properties) {
        if (ts.isSpreadAssignment(member)) {
            return UNRESOLVED;
        }

        const key =
            member.name === undefined
                ? undefined
                : ts.isComputedPropertyName(member.name)
                  ? resolvedText(member.name.expression, constants)
                  : ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNoSubstitutionTemplateLiteral(member.name)
                    ? member.name.text
                    : undefined;

        if (key === undefined) {
            return UNRESOLVED;
        }

        if (key === name) {
            found = ts.isPropertyAssignment(member)
                ? read(member.initializer)
                : ts.isShorthandPropertyAssignment(member) && !literalOnly && constants.has(key)
                  ? { kind: "string", value: constants.get(key) ?? "" }
                  : UNRESOLVED;
        }
    }

    return found;
};

const migrationId = (call: ts.CallExpression, file: ts.SourceFile, globalTables: ReadonlySet<string>, constants: ReadonlyMap<string, string>): string => {
    const id = definitionProperty(call, "id", constants, true);
    const { line } = file.getLineAndCharacterOfPosition(call.getStart(file));
    const at = `${MIGRATIONS_MODULE}:${String(line + 1)}`;

    if (id.kind !== "string") {
        throw new Error(`${at}: defineMigration needs a literal string \`id\` so the deploy can run it`);
    }

    const table = definitionProperty(call, "table", constants, false);

    // Fail closed: a table the runner cannot read could be a `.global()` one.
    if (table.kind !== "string") {
        throw new Error(
            `${at}: migration "${id.value}" needs a \`table\` that is a literal string or a top-level string constant of this module, so the deploy can tell it is not a .global() table`,
        );
    }

    if (globalTables.has(table.value)) {
        throw new Error(
            `${at}: migration "${id.value}" targets the .global() table "${table.value}", which defineMigration never reaches (it runs in the shard Durable Objects, not D1); backfill it through D1 instead`,
        );
    }

    return id.value;
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
 * literal string (a partial list would skip that migration on deploy), when its `table` is not a string the runner can read,
 * and when one targets a table in `globalTables`: a shard migration does not reach a `.global()` table's rows, and its
 * run fails on the root shard, stopping every migration after it.
 */
export const declaredMigrationIds = (source: string, globalTables: ReadonlySet<string> = new Set()): string[] => {
    const file = ts.createSourceFile(MIGRATIONS_MODULE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = constStrings(file);
    const ids: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineMigration") {
            ids.push(migrationId(node, file, globalTables, constants));
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

/** Calls one run of the backfill may make, over every phase and round. */
export const EMAIL_CANONICAL_MAX_CALLS = 4000;

/** Check-then-fill rounds one run makes: a round after the first checks again what an earlier one left. */
export const EMAIL_CANONICAL_ROUNDS = 3;

/**
 * Answers in a row that move nothing (no row filled, the cursor where it was) before the run gives up. One such answer is a
 * harmless race: every row of the batch changed under it, and the next call reads it again.
 */
export const EMAIL_CANONICAL_STALLS = 3;

/** The pause before a round that follows one which left rows behind: past the backfill's settle window, so they count again. */
export const EMAIL_CANONICAL_ROUND_PAUSE_MS = 61_000;

/** The longest `retry-after` the runner waits out; a longer one fails the step. */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

/** What one call asks for: a check page (with the run's salt) or a fill batch (with the check's start). */
export type BackfillRequest = { checkedAt: number; cursor?: string; phase: "fill" } | { cursor?: string; phase: "check"; salt: string };

/** One call of `POST /admin/backfill-email-canonical`: its HTTP status, its JSON body (or `undefined`) and `retry-after`. */
export interface BackfillCall {
    body: unknown;
    retryAfterSeconds?: number | undefined;
    status: number;
}

export interface RunBackfillOptions {
    call: (request: BackfillRequest) => Promise<BackfillCall>;
    error: (line: string) => void;
    log: (line: string) => void;
    maxCalls?: number;
    /** A fresh random salt for one check; the digests a check answers mean nothing without it. */
    salt: () => string;
    sleep: (ms: number) => Promise<unknown>;
}

interface BackfillAnswer {
    checkedAt: number | undefined;
    conflicts: number;
    cursor: string | undefined;
    digests: string[];
    filled: number;
    skipped: number;
    status: string;
}

const backfillAnswer = (body: unknown): BackfillAnswer => {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    return {
        checkedAt: typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) ? record.checkedAt : undefined,
        conflicts: count(record.conflicts),
        cursor: typeof record.cursor === "string" ? record.cursor : undefined,
        digests: Array.isArray(record.digests) ? record.digests.filter((digest): digest is string => typeof digest === "string") : [],
        filled: count(record.filled),
        skipped: count(record.skipped),
        status: typeof record.status === "string" ? record.status : "unknown",
    };
};

const conflictReason = (conflicts: number): string =>
    `${String(conflicts)} address(es) belong to more than one account once case and Unicode form are ignored; merge or rename them, then deploy again`;

/** Why a run stopped. */
class BackfillStop extends Error {}

/**
 * Drives the backfill: a check over every account, page by page, that refuses any address two accounts fold to, also
 * across pages (the digests); only then a fill, batch by batch; then a check again, which answers `done` once nothing is
 * left. A round that left rows behind (they changed meanwhile) is followed by another, up to {@link EMAIL_CANONICAL_ROUNDS}.
 * A 429 is waited out; {@link EMAIL_CANONICAL_STALLS} answers in a row that move nothing, a conflict, any other answer, or
 * `maxCalls` stop it with an error. Prints counts only, never a digest or a cursor. Returns the process exit code.
 */
export const runEmailCanonicalBackfill = async (options: RunBackfillOptions): Promise<number> => {
    const maxCalls = options.maxCalls ?? EMAIL_CANONICAL_MAX_CALLS;
    let filled = 0;
    let calls = 0;

    /** One answered call; a 429 is waited out and asked again. */
    const ask = async (request: BackfillRequest): Promise<BackfillAnswer> => {
        for (;;) {
            if (calls >= maxCalls) {
                throw new BackfillStop(`not done after ${String(maxCalls)} calls`);
            }

            let answer: BackfillCall;

            calls += 1;

            try {
                answer = await options.call(request);
            } catch (error) {
                // A fetch error names the URL in its cause, never in its name.
                throw new BackfillStop(`the request failed (${error instanceof Error ? error.name : "error"})`);
            }

            if (answer.status === 429) {
                const waitMs = (answer.retryAfterSeconds ?? 60) * 1000;

                if (waitMs > MAX_RETRY_AFTER_MS) {
                    throw new BackfillStop(`rate limited for ${String(answer.retryAfterSeconds)}s`);
                }

                options.log(`${EMAIL_CANONICAL_BACKFILL}: rate limited, waiting ${String(waitMs / 1000)}s`);
                await options.sleep(waitMs);
                continue;
            }

            const body = backfillAnswer(answer.body);

            filled += body.filled;

            if (answer.status === 409 || body.status === "conflict") {
                throw new BackfillStop(conflictReason(body.conflicts));
            }

            if (answer.status !== 200) {
                throw new BackfillStop(`answered HTTP ${String(answer.status)}`);
            }

            return body;
        }
    };

    /** Counts an answer that moved nothing; past {@link EMAIL_CANONICAL_STALLS} in a row, the run stops. */
    let stalls = 0;
    const moved = (progressed: boolean, answer: BackfillAnswer): void => {
        stalls = progressed ? 0 : stalls + 1;

        if (stalls >= EMAIL_CANONICAL_STALLS) {
            throw new BackfillStop(`made no progress over ${String(stalls)} call(s) (${answer.status})`);
        }
    };

    /** One check over every account: `undefined` when nothing is left to fill, otherwise the check's start. */
    const check = async (): Promise<number | undefined> => {
        const salt = options.salt();
        const seen = new Set<string>();
        const repeated = new Set<string>();
        let checkedAt: number | undefined;
        let cursor: string | undefined;

        for (;;) {
            const answer = await ask({ phase: "check", salt, ...(cursor === undefined ? {} : { cursor }) });

            if (answer.status === "done") {
                return undefined;
            }

            if (answer.status !== "checking" && answer.status !== "checked") {
                throw new BackfillStop(`answered ${answer.status} to a check`);
            }

            checkedAt ??= answer.checkedAt;

            for (const digest of answer.digests) {
                if (seen.has(digest)) {
                    repeated.add(digest);
                }

                seen.add(digest);
            }

            if (answer.status === "checked") {
                break;
            }

            moved(answer.cursor !== undefined && answer.cursor !== cursor, answer);
            cursor = answer.cursor ?? cursor;
        }

        if (repeated.size > 0) {
            throw new BackfillStop(conflictReason(repeated.size));
        }

        if (checkedAt === undefined) {
            throw new BackfillStop("a check answered no start time");
        }

        options.log(`${EMAIL_CANONICAL_BACKFILL}: checked ${String(seen.size)} account(s), no address shared`);

        return checkedAt;
    };

    /** One fill from the first batch to the last: how many rows it left behind. */
    const fill = async (checkedAt: number): Promise<number> => {
        let cursor: string | undefined;
        let skipped = 0;

        for (;;) {
            const answer = await ask({ checkedAt, phase: "fill", ...(cursor === undefined ? {} : { cursor }) });

            skipped += answer.skipped;

            if (answer.status === "filled") {
                return skipped;
            }

            if (answer.status !== "progress") {
                throw new BackfillStop(`answered ${answer.status} to a fill`);
            }

            moved(answer.filled > 0 || (answer.cursor !== undefined && answer.cursor !== cursor), answer);
            cursor = answer.cursor ?? cursor;
        }
    };

    try {
        // Each round ends with the next one's check, so the last round is a check alone.
        for (let round = 1; ; round += 1) {
            const checkedAt = await check();

            if (checkedAt === undefined) {
                options.log(`${EMAIL_CANONICAL_BACKFILL}: done, filled ${String(filled)} over ${String(calls)} call(s)`);

                return 0;
            }

            if (round > EMAIL_CANONICAL_ROUNDS) {
                throw new BackfillStop(`accounts still unfilled after ${String(EMAIL_CANONICAL_ROUNDS)} rounds`);
            }

            const left = await fill(checkedAt);

            if (left > 0) {
                options.log(`${EMAIL_CANONICAL_BACKFILL}: ${String(left)} account(s) changed during the fill, checking again`);
                await options.sleep(EMAIL_CANONICAL_ROUND_PAUSE_MS);
            }
        }
    } catch (error) {
        if (!(error instanceof BackfillStop)) {
            throw error;
        }

        options.error(`::error::${EMAIL_CANONICAL_BACKFILL}: ${error.message} (filled ${String(filled)} over ${String(calls)} call(s))`);

        return 1;
    }
};
