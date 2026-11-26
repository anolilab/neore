/**
 * `deploy.yml` runs the backend's data migrations after the smoke test (`scripts/run-data-migrations.ts`), so a backfill
 * no longer waits for someone holding the admin token. These properties are textual and easy to lose in an edit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import ts from "typescript";

import type { BackfillCall, BackfillRequest, CliRun } from "../scripts/data-migrations";
import {
    declaredMigrationIds,
    EMAIL_CANONICAL_DEADLINE_MS,
    EMAIL_CANONICAL_FILL_IDS,
    EMAIL_CANONICAL_ROUND_PAUSE_MS,
    EMAIL_CANONICAL_ROUNDS,
    EMAIL_CANONICAL_STALLS,
    formatMigrationRun,
    globalTablesOf,
    MIGRATION_ATTEMPTS,
    MIGRATIONS_MODULE,
    runDataMigrations,
    runEmailCanonicalBackfill,
    SCHEMA_BASELINE,
    summarizeMigrationRun,
} from "../scripts/data-migrations";
import * as migrations from "./lunora/migrations"; // eslint-disable-line import/no-namespace -- every export is a migration

const REPO_ROOT = join(import.meta.dirname, "..");
const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8");
const smokeAt = workflow.indexOf('- name: "Smoke test the deployment"');
const start = workflow.indexOf(`- name: "Run the backend's data migrations"`);
const step = workflow.slice(start);
const runner = readFileSync(join(REPO_ROOT, "scripts/run-data-migrations.ts"), "utf8");
/** The refusal of a definition whose `id` or `table` the runner cannot read. */
/** A check's digest or a row id in printed output. */
const DIGEST_OR_ID = /same|u[12]\b/u;
/** The data-migration step's `timeout-minutes`. */
const STEP_TIMEOUT = /timeout-minutes: (\d+)/u;
const UNREADABLE_DEFINITION = /needs a (`table`|literal string `id`)/u;
const baseline = readFileSync(join(REPO_ROOT, SCHEMA_BASELINE), "utf8");

/** The tables `schema.ts` declares with `.global()` in their `defineTable` chain, read from the source. */
const globalTablesInSchemaSource = (): Set<string> => {
    const file = ts.createSourceFile("schema.ts", readFileSync(join(REPO_ROOT, "backend/lunora/schema.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const callsGlobal = (node: ts.Node): boolean =>
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text === "global" || callsGlobal(node.expression.expression)
            : false;
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.getText(file).includes("defineTable(") && callsGlobal(node.initializer)) {
            found.add(node.name.text);
        }

        ts.forEachChild(node, visit);
    };

    visit(file);

    return found;
};

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "_generated" ? [] : sourceFiles(path);
        }

        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });

describe("the post-deploy data migrations", () => {
    it("run after a successful smoke test of a real deploy, as the job's last step", () => {
        expect(smokeAt).toBeGreaterThan(-1);
        expect(start).toBeGreaterThan(smokeAt);
        expect(step).toContain("!inputs.dry_run");
        expect(step).toContain("steps.smoke.conclusion == 'success'");
        expect(workflow.slice(smokeAt, start)).toContain('id: "smoke"');
        expect(step.slice(step.indexOf("\n") + 1)).not.toContain("- name:");
    });

    it("target the deployed backend, with the admin token only in the step's environment", () => {
        const expression = (inner: string): string => `"\${{ ${inner} }}"`;

        expect(step).toContain(`BACKEND_URL: ${expression("steps.origins.outputs.backend")}`);
        expect(step).toContain(`LUNORA_ADMIN_TOKEN: ${expression("secrets.LUNORA_ADMIN_TOKEN")}`);
        expect(step.match(/secrets\.LUNORA_ADMIN_TOKEN/gu)).toHaveLength(1);

        const run = step.slice(step.indexOf("run:"));

        expect(run).toContain("scripts/run-data-migrations.ts");
        expect(run).not.toContain(`\${{`);
        expect(run).not.toContain("--token");
        expect(runner).not.toContain('"--token"');
        expect(runner).toContain("process.env.BACKEND_URL");
        expect(runner).toContain('"--url", backendUrl');
    });

    it("run every declared migration, in declaration order", () => {
        const source = readFileSync(join(REPO_ROOT, MIGRATIONS_MODULE), "utf8");
        const ids = declaredMigrationIds(source);
        const exported = Object.values(migrations).map((migration) => (migration as { id: string }).id);

        const byName = (a: string, b: string): number => a.localeCompare(b);

        expect(ids.toSorted(byName)).toStrictEqual(exported.toSorted(byName));
        expect(new Set(ids).size).toBe(ids.length);
        // The required backfills, in the order they depend on each other.
        expect(ids.indexOf("drop-agent-option-fields")).toBeGreaterThan(-1);
        expect(ids.indexOf("session-options-to-session-state")).toBeGreaterThan(ids.indexOf("drop-agent-option-fields"));
        expect(ids).toContain("backfill-message-typed-text");
    });

    it("read every literal id, wherever it sits in the declaration, and refuse one that is not literal", () => {
        const source = [
            'export const a = defineMigration({ table: "t", options: { batch: { size: 10 } }, id: "after-nested" });',
            "export const b = defineMigration({ id: 'single-quoted', table: 't', up: () => ({}) });",
            'export const c = defineMigration({ up: () => { return {}; }, id: "after-up", table: "t" });',
        ].join("\n");

        expect(declaredMigrationIds(source)).toStrictEqual(["after-nested", "single-quoted", "after-up"]);
        // Lunora's codegen reads a quoted literal only.
        expect(() => declaredMigrationIds('export const t = defineMigration({ id: `template`, table: "t" });')).toThrow("literal string");
        expect(() => declaredMigrationIds(`${source}\nconst name = "x";\nexport const d = defineMigration({ id: name });`)).toThrow(
            `${MIGRATIONS_MODULE}:5: defineMigration needs a literal string`,
        );
        expect(() => declaredMigrationIds(`export const e = defineMigration({ id: \`with-\${String(1)}\` });`)).toThrow("literal string");
    });

    it("target no .global() table, which a shard migration never reaches", () => {
        const globalTables = globalTablesOf(baseline);

        // The baseline's record of the shard modes agrees with `schema.ts`.
        expect(globalTables).toStrictEqual(globalTablesInSchemaSource());
        expect(globalTables).toContain("user");
        expect(() => declaredMigrationIds(readFileSync(join(REPO_ROOT, MIGRATIONS_MODULE), "utf8"), globalTables)).not.toThrow();
        expect(runner).toContain("globalTablesOf(");
    });

    it("refuse a migration on a .global() table, naming it", () => {
        const source = [
            'export const a = defineMigration({ id: "fine", table: "messages" });',
            'export const b = defineMigration({ id: "fill-user", table: "user" });',
        ].join("\n");

        expect(declaredMigrationIds(source)).toStrictEqual(["fine", "fill-user"]);
        expect(() => declaredMigrationIds(source, new Set(["user"]))).toThrow(
            `${MIGRATIONS_MODULE}:2: migration "fill-user" targets the .global() table "user"`,
        );
    });

    it("refuse a table that is not a literal string, a constant included, naming the migration", () => {
        const global = new Set(["user"]);
        const declare = (definition: string, prelude = ""): string => `${prelude}\nexport const m = defineMigration(${definition});`;

        // Lunora's own discovery records any other value as an empty table, which `migrate up` refuses.
        expect(() => declaredMigrationIds(declare('{ id: "fine", table: MESSAGES }', 'const MESSAGES = "messages";'), global)).toThrow(
            `${MIGRATIONS_MODULE}:2: migration "fine" needs a \`table\` that is a literal string`,
        );

        for (const [definition, prelude] of [
            ['{ id: "fill", table: USER }', 'const USER = "user";'],
            ['{ id: "fill", table }', 'const table = "messages";'],
            ['{ id: "fill", table: "messages" as const }', ""],
            ['{ id: "fill", table: `messages` }', ""],
            ['({ id: "fill", table: "messages" })', ""],
            ['{ id: "fill", table: TABLES.user }', 'const TABLES = { user: "user" };'],
            ['{ id: "fill", table: pick() }', ""],
            ['{ id: "fill", table: "us" + "er" }', ""],
            ['{ id: "fill", table: "messages", ...override }', 'const override = { table: "user" };'],
            ['{ id: "fill", [TABLE]: "messages" }', 'const TABLE = "table";'],
            [`{ id: "fill", [\`ta\${"ble"}\`]: "messages" }`, ""],
            ['{ id: "fill", table: "messages", ["table"]: "user" }', ""],
            ['{ id: "fill" }', ""],
            ["definition", 'const definition = { id: "fill", table: "user" };'],
        ]) {
            expect(() => declaredMigrationIds(declare(definition!, prelude), global), definition).toThrow(UNREADABLE_DEFINITION);
        }
    });

    it("read a computed key with a literal name as Lunora's codegen does, and still refuse a .global() table under one", () => {
        const global = new Set(["user"]);

        expect(
            declaredMigrationIds(
                [
                    'export const a = defineMigration({ ["id"]: "computed-string", ["table"]: "messages" });',
                    'export const b = defineMigration({ [`id`]: "computed-template", [`table`]: "messages", 1: "numeric key" });',
                ].join("\n"),
                global,
            ),
        ).toStrictEqual(["computed-string", "computed-template"]);
        expect(() => declaredMigrationIds('export const c = defineMigration({ id: "fill-user", ["table"]: "user" });', global)).toThrow(
            `${MIGRATIONS_MODULE}:1: migration "fill-user" targets the .global() table "user"`,
        );
    });

    it("are all declared in the one module the runner reads", () => {
        const declaring = sourceFiles(join(REPO_ROOT, "backend/lunora"))
            .filter((file) => readFileSync(file, "utf8").includes("defineMigration("))
            .map((file) => relative(REPO_ROOT, file));

        expect(declaring).toStrictEqual([MIGRATIONS_MODULE]);
    });

    it("print counts only: no shard keys, no rows", () => {
        const stdout = JSON.stringify({
            code: 0,
            data: {
                id: "backfill-message-typed-text",
                result: { changed: 3, failed: 0, ok: 2, processed: 40, shards: [{ result: { id: "x" }, shardKey: "user-123" }], status: "completed" },
                subcommand: "up",
            },
        });
        const line = formatMigrationRun("backfill-message-typed-text", summarizeMigrationRun(stdout, 0));

        expect(line).toBe("backfill-message-typed-text: completed, processed 40, changed 3, shards ok 2 failed 0, timed out 0 (exit 0)");
        expect(line).not.toContain("user-123");
    });

    it("count the shards that timed out, which a retry resumes", () => {
        const stdout = JSON.stringify({
            code: 1,
            data: {
                result: {
                    changed: 0,
                    failed: 2,
                    ok: 1,
                    processed: 0,
                    shards: [
                        { error: { message: "shard timed out", timedOut: true }, shardKey: "a" },
                        { error: { message: "boom", timedOut: false }, shardKey: "b" },
                        { result: {}, shardKey: "c" },
                    ],
                    status: "in_progress",
                },
            },
        });

        expect(summarizeMigrationRun(stdout, 1)).toMatchObject({ failedShards: 2, okShards: 1, status: "in_progress", timedOutShards: 1 });
    });

    it("read an unreadable or refused run as not completed", () => {
        expect(summarizeMigrationRun("not json", 1)).toMatchObject({ exitCode: 1, status: "unknown" });
        expect(summarizeMigrationRun(JSON.stringify({ code: 3, error: "admin token required" }), 3)).toMatchObject({
            error: "admin token required",
            status: "unknown",
        });
    });
});

const SHARD_KEY = "user-secret-shard";
const ADMIN_URL = "https://backend.example.invalid/admin";

const cliRun = (status: string, exitCode = status === "completed" ? 0 : 1): CliRun => {
    const result = { changed: 1, failed: 0, ok: 1, processed: 2, shards: [{ result: {}, shardKey: SHARD_KEY }], status };

    return {
        status: exitCode,
        stdout: JSON.stringify({ code: exitCode, data: { result }, error: status === "failed" ? `request to ${ADMIN_URL} failed` : undefined }),
    };
};

/** Runs the loop with a fake CLI that answers `answers[id]` in turn, and records every call, pause and printed line. */
const runWith = async (ids: string[], answers: Record<string, CliRun[]>, production = true) => {
    const calls: string[] = [];
    const pauses: number[] = [];
    const printed: string[] = [];
    const exitCode = await runDataMigrations(ids, {
        error: (line) => {
            printed.push(line);
        },
        log: (line) => {
            printed.push(line);
        },
        production,
        run: (id) => {
            calls.push(id);

            return answers[id]?.shift() ?? cliRun("completed");
        },
        sleep: async (ms) => {
            pauses.push(ms);
        },
    });
    const output = printed.join("\n");

    expect(output).not.toContain(SHARD_KEY);
    expect(output).not.toContain(ADMIN_URL);

    return { calls, exitCode, output, pauses };
};

describe("the data migration runner", () => {
    it("runs each id once, in declaration order, when every run completes", async () => {
        const { calls, exitCode, pauses } = await runWith(["a", "b", "c"], {});

        expect(calls).toStrictEqual(["a", "b", "c"]);
        expect(pauses).toStrictEqual([]);
        expect(exitCode).toBe(0);
    });

    it("retries a run that stays in progress after a pause, then goes on", async () => {
        const { calls, exitCode, output, pauses } = await runWith(["a", "b"], { a: [cliRun("in_progress"), cliRun("in_progress"), cliRun("completed")] });

        expect(calls).toStrictEqual(["a", "a", "a", "b"]);
        expect(pauses).toHaveLength(2);
        expect(output).toContain("[attempt 3]");
        expect(exitCode).toBe(0);
    });

    it("stops after the last attempt when a run never completes, before the next id", async () => {
        const { calls, exitCode, output, pauses } = await runWith(["a", "b"], {
            a: Array.from({ length: MIGRATION_ATTEMPTS + 1 }, () => cliRun("in_progress")),
        });

        expect(calls).toHaveLength(MIGRATION_ATTEMPTS);
        expect(calls).not.toContain("b");
        expect(pauses).toHaveLength(MIGRATION_ATTEMPTS - 1);
        expect(output).toContain("::error::data migration a: in_progress");
        expect(exitCode).not.toBe(0);
    });

    it("stops at once on a failed run, before the next id, without printing the CLI's error in production", async () => {
        const { calls, exitCode, pauses } = await runWith(["a", "b"], { a: [cliRun("failed")] });

        expect(calls).toStrictEqual(["a"]);
        expect(pauses).toStrictEqual([]);
        expect(exitCode).not.toBe(0);
    });

    it("names the worker's refusal by its code in production, with no message", async () => {
        const refused: CliRun = {
            status: 4,
            stdout: JSON.stringify({ code: 4, data: { id: "a", result: { error: { code: "FORBIDDEN", message: "Admin auth required" } } } }),
        };
        const { calls, exitCode, output } = await runWith(["a", "b"], { a: [refused] });

        expect(calls).toStrictEqual(["a"]);
        expect(output).toContain("worker refused: FORBIDDEN");
        expect(output).not.toContain("Admin auth required");
        expect(exitCode).not.toBe(0);
    });

    it("prints the refusal's message and the CLI's redacted stderr outside production", async () => {
        const crashed: CliRun = {
            status: 1,
            stderr: `info  POST ${ADMIN_URL} -> up a\nerror  could not reach ${ADMIN_URL}: fetch failed\n`,
            stdout: "",
        };
        const { exitCode, output } = await runWith(["a"], { a: [crashed] }, false);

        expect(output).toContain("| error  could not reach <url>: fetch failed");
        expect(exitCode).not.toBe(0);
    });

    it("prints no stderr in production", async () => {
        const crashed: CliRun = { status: 1, stderr: "error  something broke\n", stdout: "" };
        const { output } = await runWith(["a"], { a: [crashed] });

        expect(output).not.toContain("something broke");
    });

    it("stops at once on output it cannot read", async () => {
        const { calls, exitCode, output } = await runWith(["a", "b"], { a: [{ status: 0, stdout: "not json" }] });

        expect(calls).toStrictEqual(["a"]);
        expect(output).toContain("::error::data migration a: unknown");
        expect(exitCode).not.toBe(0);
    });
});

/**
 * Runs the backfill loop against `answers` in turn, recording requests, pauses and printed lines. Its clock starts at 0 and
 * moves by each pause and by `callMs` for each call.
 */
const backfillWith = async (answers: (BackfillCall | Error)[], maxCalls?: number, production = false, callMs = 0) => {
    let time = 0;
    const pauses: number[] = [];
    const printed: string[] = [];
    const requests: BackfillRequest[] = [];
    const exitCode = await runEmailCanonicalBackfill({
        call: async (request) => {
            requests.push(request);
            time += callMs;

            const answer = answers.shift() ?? { body: { status: "done" }, status: 200 };

            if (answer instanceof Error) {
                throw answer;
            }

            return answer;
        },
        error: (line) => {
            printed.push(line);
        },
        log: (line) => {
            printed.push(line);
        },
        maxCalls,
        now: () => time,
        production,
        sleep: async (ms) => {
            pauses.push(ms);
            time += ms;
        },
    });

    return { calls: requests.length, exitCode, output: printed.join("\n"), pauses, requests };
};

const checking = (scanned: number, unfilledIds: string[] = [], token = "t1"): BackfillCall => {
    return { body: { scanned, status: "checking", token, unfilledIds }, status: 200 };
};

const checked = (scanned: number, unfilledIds: string[] = [], token = "t1"): BackfillCall => {
    return { body: { scanned, status: "checked", token, unfilledIds }, status: 200 };
};

const filledBatch = (processed: number, filled = processed, skipped = 0): BackfillCall => {
    return { body: { conflicts: 0, filled, processed, skipped, status: "progress" }, status: 200 };
};

const done: BackfillCall = { body: { status: "done" }, status: 200 };

/** `count` ids, `u0` onwards. */
const idsOf = (count: number, from = 0): string[] => Array.from({ length: count }, (_, index) => `u${String(from + index)}`);

describe("the user.emailCanonical backfill in the deploy", () => {
    it("runs in the post-deploy step, through D1, before the shard migrations, and both decide the exit code", () => {
        expect(runner).toContain('"/admin/backfill-email-canonical"');
        expect(runner).toContain("signal: AbortSignal.timeout(");
        expect(runner).toContain("body: JSON.stringify(request)");
        expect(runner.indexOf("runEmailCanonicalBackfill(")).toBeLessThan(runner.indexOf("runDataMigrations(ids"));
        expect(runner).toContain("process.exitCode = backfilled === 0 && migrated === 0 ? 0 : 1;");
        expect(runner).toContain("authorization: `Bearer ${process.env.LUNORA_ADMIN_TOKEN");
    });

    it("checks every page under the check's token, then fills the unfilled ids one per call from it, then checks again, and prints counts only", async () => {
        const { calls, exitCode, output, requests } = await backfillWith([
            checking(2, idsOf(2)),
            checked(1, idsOf(1, 2)),
            filledBatch(1),
            filledBatch(1),
            filledBatch(1),
            done,
        ]);

        expect(EMAIL_CANONICAL_FILL_IDS).toBe(1);
        expect(calls).toBe(6);
        expect(exitCode).toBe(0);
        expect(requests).toStrictEqual([
            { phase: "check" },
            { phase: "check", token: "t1" },
            { ids: ["u0"], phase: "fill", token: "t1" },
            { ids: ["u1"], phase: "fill", token: "t1" },
            { ids: ["u2"], phase: "fill", token: "t1" },
            { phase: "check" },
        ]);
        expect(output).toBe(
            ["backfill-email-canonical: checked 3 account(s), no address shared, 3 to fill", "backfill-email-canonical: done, filled 3 over 6 call(s)"].join(
                "\n",
            ),
        );
    });

    it("stops at a check page's conflict before any fill, and prints no token or id", async () => {
        const { exitCode, output, requests } = await backfillWith([
            checking(2, ["u1"], "check-token-1"),
            { body: { conflicts: 1, status: "conflict" }, status: 409 },
        ]);

        expect(exitCode).toBe(1);
        expect(requests.every((request) => request.phase === "check")).toBe(true);
        expect(output).toContain("::error::backfill-email-canonical: 1 address(es) belong to more than one account");
        expect(output).not.toMatch(DIGEST_OR_ID);
        expect(output).not.toContain("check-token-1");
    });

    it("stops when a check page answers no token or another check's", async () => {
        const missing = await backfillWith([{ body: { scanned: 1, status: "checked", unfilledIds: ["u1"] }, status: 200 }]);
        const switched = await backfillWith([checking(1, ["u1"], "t1"), checked(1, ["u2"], "t2")]);

        expect(missing.exitCode).toBe(1);
        expect(switched.exitCode).toBe(1);
        expect(switched.output).toContain("a check answered no token, or another check's");
        expect(switched.requests.every((request) => request.phase === "check")).toBe(true);
    });

    it("waits out a 429, then goes on", async () => {
        const { calls, exitCode, pauses } = await backfillWith([{ body: undefined, retryAfterSeconds: 42, status: 429 }, done]);

        expect(pauses).toStrictEqual([42_000]);
        expect(calls).toBe(2);
        expect(exitCode).toBe(0);
    });

    it("fails on a conflict, naming the count and what to do", async () => {
        const { exitCode, output } = await backfillWith([
            checked(1, idsOf(12)),
            filledBatch(EMAIL_CANONICAL_FILL_IDS),
            { body: { conflicts: 2, filled: 0, processed: 0, skipped: 0, status: "conflict" }, status: 409 },
        ]);

        expect(exitCode).toBe(1);
        expect(output).toContain("::error::backfill-email-canonical: 2 address(es) belong to more than one account");
        expect(output).toContain(`filled ${String(EMAIL_CANONICAL_FILL_IDS)} over 3 call(s)`);
    });

    it("goes on after a fill that filled nothing because its row changed", async () => {
        const { exitCode, requests } = await backfillWith([
            checked(3, idsOf(3)),
            filledBatch(1),
            // The row changed under the fill: processed, nothing filled.
            filledBatch(1, 0, 1),
            filledBatch(1),
            // The skipped row waits for the next round's check.
            checked(3, ["u1"], "t2"),
            filledBatch(1),
            done,
        ]);

        expect(exitCode).toBe(0);
        expect(requests.filter((request) => request.phase === "fill")).toStrictEqual([
            { ids: ["u0"], phase: "fill", token: "t1" },
            { ids: ["u1"], phase: "fill", token: "t1" },
            { ids: ["u2"], phase: "fill", token: "t1" },
            { ids: ["u1"], phase: "fill", token: "t2" },
        ]);
    });

    it("retries a fill answer that processed nothing, and goes on once one does", async () => {
        const { exitCode, output } = await backfillWith([checked(1, idsOf(2)), filledBatch(0), filledBatch(0), filledBatch(1), filledBatch(1), done]);

        expect(exitCode).toBe(0);
        expect(output).toContain("done, filled 2 over 6 call(s)");
    });

    it(`fails after ${String(EMAIL_CANONICAL_STALLS)} answers in a row that move nothing`, async () => {
        const stuck = await backfillWith([checked(1, idsOf(2)), filledBatch(0), filledBatch(0), filledBatch(0), filledBatch(0)]);
        const stuckCheck = await backfillWith([checking(1), checking(0), checking(0), checking(0), checking(0)]);

        expect(stuck.exitCode).toBe(1);
        expect(stuck.output).toContain(`made no progress over ${String(EMAIL_CANONICAL_STALLS)} call(s)`);
        expect(stuck.calls).toBe(1 + EMAIL_CANONICAL_STALLS);
        expect(stuckCheck.output).toContain("made no progress");
    });

    it("checks again after a fill that left changed rows behind, pausing past the settle window, and gives up after its rounds", async () => {
        const again = await backfillWith([checked(2, ["u1", "u2"]), filledBatch(1), filledBatch(1, 0, 1), checked(2, ["u2"], "t2"), filledBatch(1), done]);

        expect(again.exitCode).toBe(0);
        expect(again.pauses).toStrictEqual([EMAIL_CANONICAL_ROUND_PAUSE_MS]);
        expect(again.requests[4]).toStrictEqual({ ids: ["u2"], phase: "fill", token: "t2" });

        const rounds = Array.from({ length: EMAIL_CANONICAL_ROUNDS + 1 }, () => [checked(1, ["u1"]), filledBatch(1, 0, 1)]).flat();
        const restless = await backfillWith(rounds);

        expect(restless.exitCode).toBe(1);
        expect(restless.output).toContain(`accounts still unfilled after ${String(EMAIL_CANONICAL_ROUNDS)} rounds`);
    });

    it("says why a call was refused: the code and message outside production, the code alone in production, never a URL", async () => {
        const thrown = { body: { code: "BAD_REQUEST", message: "findMany failed at https://backend.example.invalid/x?token=1" }, status: 400 };
        const staging = await backfillWith([thrown]);
        const production = await backfillWith([thrown], undefined, true);
        const nested = await backfillWith([{ body: { error: { code: "VALIDATION_ERROR", message: "bad output" } }, status: 400 }]);
        const plain = await backfillWith([{ body: { message: "Bad Request" }, status: 400 }]);
        // How the Worker answers an error a mutation threw.
        const coded = await backfillWith([{ body: { code: "INVALID_CURSOR", error: "invalid cursor" }, status: 400 }]);

        expect(staging.output).toBe("::error::backfill-email-canonical: answered HTTP 400 (BAD_REQUEST: findMany failed at <url>) (filled 0 over 1 call(s))");
        expect(production.output).toBe("::error::backfill-email-canonical: answered HTTP 400 (BAD_REQUEST) (filled 0 over 1 call(s))");
        expect(nested.output).toContain("answered HTTP 400 (VALIDATION_ERROR: bad output)");
        expect(plain.output).toContain("answered HTTP 400 (Bad Request)");
        expect(coded.output).toContain("answered HTTP 400 (INVALID_CURSOR: invalid cursor)");
        expect(runner).toContain('production: process.env.STAGE === "production"');
    });

    it("fails on any other status, on a request error, and after its call cap", async () => {
        const refused = await backfillWith([{ body: { error: "Unauthorized" }, status: 401 }]);
        const unreachable = await backfillWith([new TypeError("fetch failed https://backend.example.invalid")]);

        expect(refused.output).toContain("answered HTTP 401 (Unauthorized)");
        expect(unreachable.output).toBe("::error::backfill-email-canonical: the request failed (TypeError) (filled 0 over 1 call(s))");

        const capped = await backfillWith([checked(1, idsOf(30)), filledBatch(1), filledBatch(1), filledBatch(1)], 3);

        expect(capped.exitCode).toBe(1);
        expect(capped.output).toContain("not done after 3 calls");
    });

    it("stops at its deadline, well inside the step's timeout, with its own message, keeping what it filled", async () => {
        const stepMinutes = Number(STEP_TIMEOUT.exec(step)?.[1]);

        expect(EMAIL_CANONICAL_DEADLINE_MS).toBeLessThanOrEqual((stepMinutes - 3) * 60 * 1000);

        // A minute a call: the call that would start at the deadline is not made.
        const callMs = 60_000;
        const startedInTime = EMAIL_CANONICAL_DEADLINE_MS / callMs;
        const slow = await backfillWith([checked(1, idsOf(100)), ...Array.from({ length: 99 }, () => filledBatch(1))], undefined, false, callMs);

        expect(slow.exitCode).toBe(1);
        expect(slow.calls).toBe(startedInTime);
        expect(slow.output).toContain(
            `::error::backfill-email-canonical: deadline reached, ${String(startedInTime - 1)} filled; the next deploy continues (filled ${String(startedInTime - 1)} over ${String(startedInTime)} call(s))`,
        );

        // A rate-limit wait that would end past the deadline is not begun.
        const limited: BackfillCall = { body: {}, retryAfterSeconds: EMAIL_CANONICAL_DEADLINE_MS / 2 / 1000 - 1, status: 429 };
        const waited = await backfillWith([limited, limited, limited]);

        expect(waited.exitCode).toBe(1);
        expect(waited.pauses).toHaveLength(2);
        expect(waited.output).toContain("deadline reached, 0 filled; the next deploy continues");

        // A round pause too.
        const rounds = await backfillWith([checked(1, ["u1"]), filledBatch(1, 0, 1)], undefined, false, EMAIL_CANONICAL_DEADLINE_MS / 2);

        expect(rounds.exitCode).toBe(1);
        expect(rounds.pauses).toStrictEqual([]);
        expect(rounds.output).toContain("deadline reached");
    });

    it("finishes normally when it is done before its deadline", async () => {
        const callMs = EMAIL_CANONICAL_DEADLINE_MS / 4;
        const { exitCode, output } = await backfillWith([checked(1, ["u1"]), filledBatch(1), done], undefined, false, callMs);

        expect(exitCode).toBe(0);
        expect(output).toContain("done, filled 1 over 3 call(s)");
    });
});
