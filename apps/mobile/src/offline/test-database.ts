import { DatabaseSync } from "node:sqlite";

import type { SqlDatabase, SqlParameter as SqlParametereter } from "./sql";

/** An in-memory SQLite behind the same async seam expo-sqlite fills in the app. Tests only. */
export const createTestDatabase = (): SqlDatabase & { close: () => void } => {
    const database = new DatabaseSync(":memory:");

    return {
        close: () => database.close(),
        execAsync: async (source) => {
            database.exec(source);
        },
        getAllAsync: async <T>(source: string, params: SqlParametereter[] = []) => database.prepare(source).all(...params) as T[],
        runAsync: async (source, params = []) => {
            database.prepare(source).run(...params);
        },
        withTransactionAsync: async (task) => {
            database.exec("BEGIN");

            try {
                await task();
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            }
        },
    };
};
