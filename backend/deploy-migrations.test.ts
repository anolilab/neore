/**
 * `deploy.yml` runs the backend's data migrations after the smoke test (`scripts/run-data-migrations.ts`), so a backfill
 * no longer waits for someone holding the admin token. These properties are textual and easy to lose in an edit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { declaredMigrationIds, formatMigrationRun, MIGRATIONS_MODULE, summarizeMigrationRun } from "../scripts/data-migrations";
import * as migrations from "./lunora/migrations"; // eslint-disable-line import/no-namespace -- every export is a migration

const REPO_ROOT = join(import.meta.dirname, "..");
const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8");
const smokeAt = workflow.indexOf('- name: "Smoke test the deployment"');
const start = workflow.indexOf(`- name: "Run the backend's data migrations"`);
const step = workflow.slice(start);
const runner = readFileSync(join(REPO_ROOT, "scripts/run-data-migrations.ts"), "utf8");

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
