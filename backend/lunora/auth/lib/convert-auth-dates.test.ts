/**
 * `ensureAuthDatesConverted` against the real tables: the schema's `.global()` tables are provisioned into a plain
 * SQLite the way D1 gets them, rows are written with ISO-string dates the way `@lunora/auth` up to alpha.275 wrote
 * them, and the conversion has to leave epoch-ms numbers. The schema is the real one, not the harness's copy that
 * `test/setup-harness.ts` turns into `.shardBy()` tables, so the `.global()` auth tables are provisioned here. Running it against every better-auth table also pins that
 * each one the auth options name is provisioned (a missing table would make the whole conversion fail).
 */
import { DatabaseSync } from "node:sqlite";

import { runD1GlobalTableMigrations } from "@lunora/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthOptions } from "../../auth";
import { ensureAuthDatesConverted, resetAuthDateConversionForTests, RETRY_AFTER_MS } from "./convert-auth-dates";

const { default: schema } = await vi.importActual<typeof import("../../schema")>("../../schema");

type Exec = Parameters<typeof ensureAuthDatesConverted>[0];

const sqliteExec = (database: DatabaseSync): Exec =>
    ({
        all: async (sql, parameters) => database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[],
        run: async (sql, parameters) => {
            database.prepare(sql).run(...(parameters as never[]));
        },
    }) as Exec;

const CREATED = "2026-11-20T10:00:00.000Z";
const EXPIRES = "2026-12-20T10:00:00.000Z";

describe(ensureAuthDatesConverted, () => {
    let database: DatabaseSync;
    let exec: Exec;

    beforeEach(async () => {
        resetAuthDateConversionForTests();
        database = new DatabaseSync(":memory:");
        exec = sqliteExec(database);
        await runD1GlobalTableMigrations(exec as never, schema as never);
        vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    it("rewrites the ISO dates in user and session rows as epoch ms", async () => {
        expect.assertions(4);

        database
            .prepare(`INSERT INTO "user" ("_creationTime", "id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(1, "u1", "Ada", "ada@example.com", 1, CREATED, CREATED);
        database
            .prepare(`INSERT INTO "session" ("_creationTime", "id", "userId", "token", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(1, "s1", "u1", "token-1", EXPIRES, CREATED, CREATED);

        await ensureAuthDatesConverted(exec, buildAuthOptions());

        const user = database.prepare(`SELECT "createdAt", "updatedAt" FROM "user" WHERE "id" = 'u1'`).get() as Record<string, unknown>;
        const session = database.prepare(`SELECT "expiresAt", "createdAt" FROM "session" WHERE "id" = 's1'`).get() as Record<string, unknown>;

        expect(user.createdAt).toBe(Date.parse(CREATED));
        expect(user.updatedAt).toBe(Date.parse(CREATED));
        expect(session.expiresAt).toBe(Date.parse(EXPIRES));
        expect(session.createdAt).toBe(Date.parse(CREATED));
    });

    it("runs once per isolate after a success", async () => {
        expect.assertions(1);

        const all = vi.spyOn(exec, "all");

        await ensureAuthDatesConverted(exec, buildAuthOptions());
        const afterFirst = all.mock.calls.length;

        await ensureAuthDatesConverted(exec, buildAuthOptions());

        expect(all.mock.calls).toHaveLength(afterFirst);
    });

    it("never rejects, and retries a failure only after the back-off", async () => {
        expect.assertions(4);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        database
            .prepare(`INSERT INTO "user" ("_creationTime", "id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(1, "u2", "Bob", "bob@example.com", 1, "not a date", CREATED);

        let clock = 1_000_000;
        const now = (): number => clock;

        await expect(ensureAuthDatesConverted(exec, buildAuthOptions(), now)).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledOnce();

        clock += RETRY_AFTER_MS - 1;
        await ensureAuthDatesConverted(exec, buildAuthOptions(), now);

        expect(error).toHaveBeenCalledOnce();

        clock += 1;
        await ensureAuthDatesConverted(exec, buildAuthOptions(), now);

        expect(error).toHaveBeenCalledTimes(2);
    });
});
