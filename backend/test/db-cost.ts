/**
 * Counts what a procedure costs the database, for tests that pin it.
 *
 * The harness runs every table on one in-memory `node:sqlite` database
 * (`test/setup-harness.ts`), and every statement the shard engine issues goes
 * through `DatabaseSync#prepare`. Wrapping it gives, per call:
 *
 * - `statements` — SQL statements, transaction control (`BEGIN`/`COMMIT`/…)
 *   excluded. Deployed, a statement on a sharded table is a local SQLite call
 *   inside the Durable Object, and one on a `.global()` table is a D1 round
 *   trip, so `global` counts those separately.
 * - `rowsRead` — rows the statements returned to the engine, which is what a
 *   query pays for regardless of how many it hands back.
 *
 * Wall-clock time is deliberately not measured: it depends on the machine.
 */
import { DatabaseSync } from "node:sqlite";

import { vi } from "vitest";

export interface DbCost {
    /** Statements per table (`(get probe)` = an un-hinted `db.get`), for a failure message that says where the cost went. */
    byTable: Record<string, number>;
    /** Statements on `.global()` (D1) tables — each a network round trip deployed. */
    global: number;
    rowsRead: number;
    statements: number;
}

const TRANSACTION_CONTROL = /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const TABLE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([A-Z_]\w*)"?/i;

/** Table names declared `.global()` in the REAL schema (the harness rewrites them to sharded). */
const loadGlobalTables = async (): Promise<Set<string>> => {
    const actual = await vi.importActual<{ default: { tables: Record<string, { shardMode?: { kind?: string } }> } }>("../lunora/schema");

    return new Set(
        Object.entries(actual.default.tables)
            .filter(([, table]) => table.shardMode?.kind === "global")
            .map(([name]) => name),
    );
};

/** Runs `run` and reports the statements and rows it cost. Calls must not overlap. */
export const measureDb = async <R>(run: () => Promise<R>): Promise<{ cost: DbCost; result: R }> => {
    const globalTables = await loadGlobalTables();
    const cost: DbCost = { byTable: {}, global: 0, rowsRead: 0, statements: 0 };
    const { prepare } = DatabaseSync.prototype;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function countedPrepare(this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql);

        if (TRANSACTION_CONTROL.test(sql)) {
            return statement;
        }

        // An un-hinted `db.get(id)` is one UNION ALL over every table.
        const table = sql.includes(" AS __t__,") ? "(get probe)" : (TABLE.exec(sql)?.[1] ?? "(none)");

        cost.statements += 1;
        cost.byTable[table] = (cost.byTable[table] ?? 0) + 1;

        if (globalTables.has(table)) {
            cost.global += 1;
        }

        const all = statement.all.bind(statement);

        statement.all = ((...parameters: never[]) => {
            const rows = all(...parameters);

            cost.rowsRead += rows.length;

            return rows;
        }) as typeof statement.all;

        return statement;
    });

    try {
        return { cost, result: await run() };
    } finally {
        spy.mockRestore();
    }
};
