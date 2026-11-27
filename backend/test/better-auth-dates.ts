/**
 * Rows as better-auth leaves them in D1: its Lunora adapter sets `supportsDates: false` and writes past Lunora's
 * validators, so its date columns hold ISO strings where `schema.ts` declares `v.number()`. The harness validates its own
 * writes, so a test inserts a row normally and then rewrites its dates as text in the document the harness's SQLite holds.
 */
import { DatabaseSync } from "node:sqlite";

import { lunoraTest } from "@lunora/testing";
import { vi } from "vitest";

/** A harness and the SQLite under it. */
export const harnessWithSqlite = (schema: unknown): { harness: ReturnType<typeof lunoraTest>; sqlite: DatabaseSync } => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    try {
        const harness = lunoraTest(schema as never);

        return { harness, sqlite: prepare.mock.contexts[0] as DatabaseSync };
    } finally {
        prepare.mockRestore();
    }
};

/** Rewrites `columns` of row `id` in `table` as the ISO strings better-auth stores; a column not held as a number is left. */
export const storeDatesAsText = (sqlite: DatabaseSync, table: string, id: string, columns: ReadonlyArray<string>): void => {
    const { __doc__: stored } = sqlite.prepare(`SELECT __doc__ FROM "${table}" WHERE id = ?`).get(id) as { __doc__: string };
    const doc = JSON.parse(stored) as Record<string, unknown>;

    for (const column of columns) {
        const value = doc[column];

        if (typeof value === "number") {
            doc[column] = new Date(value).toISOString();
        }
    }

    sqlite.prepare(`UPDATE "${table}" SET __doc__ = ? WHERE id = ?`).run(JSON.stringify(doc), id);
};
