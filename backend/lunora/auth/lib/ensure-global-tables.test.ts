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
const PRAGMA_TABLE = /^PRAGMA table_info\("([^"]+)"\)$/u;
const ALTER_ADD_COLUMN = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)"/u;

/**
 * A D1 stand-in that knows the marker table and the given tables' columns. `racingColumn` makes an `ALTER ... ADD COLUMN` fail as if another
 * isolate had just added the column, after this isolate's `PRAGMA` read it as missing.
 */
const fakeDatabase = (options: { columns?: Record<string, string[]>; racingColumn?: boolean } = {}) => {
    let markerTable: Set<string> | undefined;
    const tables = new Map(
        Object.entries(options.columns ?? { pinWriteLeases: ["expiresAt", "userId", "writerId"] }).map(([name, columns]) => [name, new Set(columns)]),
    );
    const statements: string[] = [];

    return {
        exec: {
            all: async (sql: string, parameters: ReadonlyArray<unknown>) => {
                statements.push(sql);

                const pragma = PRAGMA_TABLE.exec(sql);

                if (pragma) {
                    return [...(tables.get(pragma[1]!) ?? [])].map((name) => {
                        return { name };
                    });
                }

                if (!markerTable) {
                    throw new Error("D1_ERROR: no such table: globalSchemaMarker");
                }

                return markerTable.has(String(parameters[0])) ? [{ 1: 1 }] : [];
            },
            run: async (sql: string, parameters: ReadonlyArray<unknown>) => {
                statements.push(sql);

                const alter = ALTER_ADD_COLUMN.exec(sql);

                if (alter) {
                    const columns = tables.get(alter[1]!) ?? new Set<string>();

                    if (options.racingColumn === true || columns.has(alter[2]!)) {
                        throw new Error(`D1_ERROR: duplicate column name: ${alter[2]}`);
                    }

                    columns.add(alter[2]!);
                    tables.set(alter[1]!, columns);

                    return;
                }

                if (sql.startsWith("CREATE TABLE IF NOT EXISTS")) {
                    markerTable ??= new Set();
                } else if (sql.startsWith("INSERT OR IGNORE")) {
                    markerTable?.add(String(parameters[0]));
                }
            },
        },
        statements,
        tables,
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

describe("the writerId column on pinWriteLeases", () => {
    beforeEach(() => {
        migrate.mockReset();
        migrate.mockImplementation(async () => {});
        resetEnsureGlobalTablesForTests();
    });

    it("is added to a table an earlier build created, once, before the fingerprint is recorded", async () => {
        const database = fakeDatabase({ columns: { pinWriteLeases: ["expiresAt", "userId"] } });

        await ensureGlobalTables(database.exec);

        expect(database.tables.get("pinWriteLeases")?.has("writerId")).toBe(true);
        expect(database.statements.filter((sql) => sql.startsWith("ALTER TABLE"))).toHaveLength(1);
        expect(database.statements.at(-1)).toMatch(INSERT_MARKER);
    });

    it("is left alone on a table that already has it", async () => {
        const database = fakeDatabase();

        await ensureGlobalTables(database.exec);

        expect(database.statements.some((sql) => sql.startsWith("ALTER TABLE"))).toBe(false);
    });

    it("is not an error when another isolate adds it between this isolate's read and its write", async () => {
        const database = fakeDatabase({ columns: { pinWriteLeases: ["expiresAt", "userId"] }, racingColumn: true });

        await expect(ensureGlobalTables(database.exec)).resolves.toBeUndefined();
        expect(database.statements.at(-1)).toMatch(INSERT_MARKER);
    });
});
