/**
 * `ensureGlobalTables` sweeps once per schema fingerprint per DATABASE, not once
 * per isolate: a cold isolate against a provisioned database pays one marker
 * read instead of Lunora's ~370-statement provisioning sweep.
 *
 * The sweep itself is Lunora's and is stubbed; what is pinned here is when it
 * runs, and that the marker is only ever written after it succeeded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { migrate } = vi.hoisted(() => {
    return { migrate: vi.fn(async () => {}) };
});

vi.mock("@lunora/d1", () => {
    return { runD1GlobalTableMigrations: migrate };
});

const { ensureGlobalTables, globalSchemaFingerprint, resetEnsureGlobalTablesForTests } = await import("./ensure-global-tables");

const INSERT_MARKER = /^INSERT OR IGNORE INTO "globalSchemaMarker"/u;
const SELECT_MARKER = /^SELECT 1 FROM "globalSchemaMarker"/u;

/** A D1 stand-in that knows only the marker table. */
const fakeDatabase = () => {
    let markerTable: Set<string> | undefined;
    const statements: string[] = [];

    return {
        exec: {
            all: async (sql: string, parameters: ReadonlyArray<unknown>) => {
                statements.push(sql);

                if (!markerTable) {
                    throw new Error("D1_ERROR: no such table: globalSchemaMarker");
                }

                return markerTable.has(String(parameters[0])) ? [{ 1: 1 }] : [];
            },
            run: async (sql: string, parameters: ReadonlyArray<unknown>) => {
                statements.push(sql);

                if (sql.startsWith("CREATE TABLE IF NOT EXISTS")) {
                    markerTable ??= new Set();
                } else if (sql.startsWith("INSERT OR IGNORE")) {
                    markerTable?.add(String(parameters[0]));
                }
            },
        },
        statements,
    };
};

describe(ensureGlobalTables, () => {
    beforeEach(() => {
        migrate.mockReset();
        migrate.mockImplementation(async () => {});
        resetEnsureGlobalTablesForTests();
    });

    it("sweeps a database it has never provisioned, then records the fingerprint", async () => {
        const database = fakeDatabase();

        await ensureGlobalTables(database.exec);

        expect(migrate).toHaveBeenCalledTimes(1);
        expect(database.statements.at(-1)).toMatch(INSERT_MARKER);
    });

    it("skips the sweep in a new isolate once the database carries the fingerprint", async () => {
        const database = fakeDatabase();

        await ensureGlobalTables(database.exec);
        resetEnsureGlobalTablesForTests(); // a fresh isolate
        database.statements.length = 0;

        await ensureGlobalTables(database.exec);

        expect(migrate).toHaveBeenCalledTimes(1);
        expect(database.statements).toHaveLength(1);
        expect(database.statements[0]).toMatch(SELECT_MARKER);
    });

    it("memoises within an isolate", async () => {
        const database = fakeDatabase();

        await Promise.all([ensureGlobalTables(database.exec), ensureGlobalTables(database.exec)]);
        await ensureGlobalTables(database.exec);

        expect(migrate).toHaveBeenCalledTimes(1);
        expect(database.statements.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(1);
    });

    it("records nothing when the sweep fails, and retries on the next request", async () => {
        const database = fakeDatabase();

        migrate.mockRejectedValueOnce(new Error("D1 is down"));

        await expect(ensureGlobalTables(database.exec)).rejects.toThrow("D1 is down");
        expect(database.statements.some((sql) => sql.startsWith("INSERT"))).toBe(false);

        await ensureGlobalTables(database.exec);

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(database.statements.at(-1)).toMatch(INSERT_MARKER);
    });
});

describe(globalSchemaFingerprint, () => {
    const table = (kind: string, index: string) => {
        return { indexes: [{ fields: [index], name: index }], shape: { name: { kind: "string" } }, shardMode: { kind }, triggers: () => {} };
    };

    it("is stable for the same schema", async () => {
        const schema = { tables: { a: table("global", "x") } };

        await expect(globalSchemaFingerprint(schema)).resolves.toBe(await globalSchemaFingerprint({ tables: { a: table("global", "x") } }));
    });

    it("changes when a global table's DDL inputs change", async () => {
        await expect(globalSchemaFingerprint({ tables: { a: table("global", "x") } })).resolves.not.toBe(
            await globalSchemaFingerprint({ tables: { a: table("global", "y") } }),
        );
    });

    it("ignores tables that do not live in D1", async () => {
        await expect(globalSchemaFingerprint({ tables: { a: table("global", "x"), b: table("shardBy", "x") } })).resolves.toBe(
            await globalSchemaFingerprint({ tables: { a: table("global", "x"), b: table("shardBy", "y") } }),
        );
    });
});
