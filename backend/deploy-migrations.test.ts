/**
 * `deploy.yml` runs the backend's data migrations after the smoke test (`scripts/run-data-migrations.ts`), so a backfill
 * no longer waits for someone holding the admin token. These properties are textual and easy to lose in an edit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import ts from "typescript";

import type { BackfillCall, CliRun } from "../scripts/data-migrations";
import {
    declaredMigrationIds,
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
            "export const b = defineMigration({ id: 'single-quoted', up: () => ({}) });",
            "export const c = defineMigration({ up: () => { return {}; }, id: `template-literal` });",
        ].join("\n");

        expect(declaredMigrationIds(source)).toStrictEqual(["after-nested", "single-quoted", "template-literal"]);
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

/** Runs the backfill loop against `answers` in turn, recording calls, pauses and printed lines. */
const backfillWith = async (answers: (BackfillCall | Error)[], maxCalls?: number) => {
    const pauses: number[] = [];
    const printed: string[] = [];
    let calls = 0;
    const exitCode = await runEmailCanonicalBackfill({
        call: async () => {
            calls += 1;

            const answer = answers.shift() ?? { body: { conflicts: 0, filled: 0, remaining: 0, status: "done" }, status: 200 };

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
        sleep: async (ms) => {
            pauses.push(ms);
        },
    });

    return { calls, exitCode, output: printed.join("\n"), pauses };
};

const progress = (filled: number, remaining: number): BackfillCall => {
    return { body: { conflicts: 0, filled, remaining, status: "progress" }, status: 200 };
};

describe("the user.emailCanonical backfill in the deploy", () => {
    it("runs in the post-deploy step, through D1, before the shard migrations, and both decide the exit code", () => {
        expect(runner).toContain('"/admin/backfill-email-canonical"');
        expect(runner).toContain("signal: AbortSignal.timeout(");
        expect(runner.indexOf("runEmailCanonicalBackfill(")).toBeLessThan(runner.indexOf("runDataMigrations(ids"));
        expect(runner).toContain("process.exitCode = backfilled === 0 && migrated === 0 ? 0 : 1;");
        expect(runner).toContain("authorization: `Bearer ${process.env.LUNORA_ADMIN_TOKEN");
    });

    it("calls until done and prints counts only", async () => {
        const { calls, exitCode, output } = await backfillWith([
            progress(8, 9),
            progress(8, 1),
            { body: { conflicts: 0, filled: 1, remaining: 0, status: "done" }, status: 200 },
        ]);

        expect(calls).toBe(3);
        expect(exitCode).toBe(0);
        expect(output).toBe("backfill-email-canonical: done, filled 17 over 3 call(s)");
    });

    it("waits out a 429, then goes on", async () => {
        const { calls, exitCode, pauses } = await backfillWith([{ body: undefined, retryAfterSeconds: 42, status: 429 }, progress(2, 0)]);

        expect(pauses).toStrictEqual([42_000]);
        expect(calls).toBe(3);
        expect(exitCode).toBe(0);
    });

    it("fails on a conflict, naming the count and what to do", async () => {
        const { calls, exitCode, output } = await backfillWith([
            progress(8, 3),
            { body: { conflicts: 2, filled: 0, remaining: 3, status: "conflict" }, status: 409 },
        ]);

        expect(calls).toBe(2);
        expect(exitCode).toBe(1);
        expect(output).toContain("::error::backfill-email-canonical: 2 address(es) belong to more than one account");
        expect(output).toContain("filled 8 over 2 call(s)");
    });

    it("fails on a call that makes no progress, on any other status, on a request error, and after its call cap", async () => {
        const stuck = await backfillWith([progress(0, 4)]);
        const refused = await backfillWith([{ body: { error: "Unauthorized" }, status: 401 }]);
        const unreachable = await backfillWith([new TypeError("fetch failed https://backend.example.invalid")]);

        expect(stuck.output).toContain("made no progress");
        expect(refused.output).toContain("answered HTTP 401");
        expect(unreachable.output).toBe("::error::backfill-email-canonical: the request failed (TypeError) (filled 0 over 1 call(s))");

        const capped = await backfillWith([progress(1, 5), progress(1, 4), progress(1, 3)], 2);

        expect(capped.exitCode).toBe(1);
        expect(capped.output).toContain("not done after 2 calls");
    });
});
