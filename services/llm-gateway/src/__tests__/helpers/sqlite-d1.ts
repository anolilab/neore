/// <reference types="node" />

/**
 * A D1 stand-in backed by a real in-memory SQLite database whose schema is built by
 * applying the gateway's migrations in order. For code whose contract is its SQL —
 * the mock D1 in mock-env.ts never evaluates a predicate, so it cannot tell a wrong
 * `WHERE` from a right one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations");

export const migratedDatabase = (): DatabaseSync => {
    const db = new DatabaseSync(":memory:");
    // Zero-padded names, so a plain string order is the migration order.
    const files = readdirSync(MIGRATIONS)
        .filter((name) => name.endsWith(".sql"))
        .toSorted((a, b) => a.localeCompare(b));

    for (const file of files) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }

    return db;
};

type SqlValue = bigint | null | number | string;

/** The statement surface the gateway uses: bind, all, first, run (with `meta.changes`). */
export const d1FromSqlite = (db: DatabaseSync): D1Database =>
    ({
        prepare: (sql: string) => {
            const statement = (values: SqlValue[]) => {
                return {
                    all: async () => {
                        return { results: db.prepare(sql).all(...values), success: true };
                    },
                    bind: (...next: SqlValue[]) => statement(next),
                    first: async () => db.prepare(sql).get(...values) ?? null,
                    run: async () => {
                        const { changes } = db.prepare(sql).run(...values);

                        return { meta: { changes: Number(changes) }, success: true };
                    },
                };
            };

            return statement([]);
        },
    }) as unknown as D1Database;
