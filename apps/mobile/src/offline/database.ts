import type { SQLiteDatabase } from "expo-sqlite";
import { openDatabaseAsync } from "expo-sqlite";

import type { OfflineCache } from "./cache";
import { createOfflineCache } from "./cache";

const DATABASE_NAME = "neore-offline-cache.db";

let cache: OfflineCache | undefined;
let opening: Promise<SQLiteDatabase> | undefined;

const database = (): Promise<SQLiteDatabase> => {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- opened once, on first use
    opening ??= openDatabaseAsync(DATABASE_NAME);

    return opening;
};

/**
 * The one cache for the app, on the device's SQLite file. The file opens on first use. Sign-out empties it, so it
 * holds nothing once nobody is signed in.
 */
export const getOfflineCache = (): OfflineCache => {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- the lazy singleton is the point: the file opens on first use
    cache ??= createOfflineCache({
        execAsync: async (source) => {
            const connection = await database();

            await connection.execAsync(source);
        },
        getAllAsync: async (source, params) => {
            const connection = await database();

            return connection.getAllAsync(source, params ?? []);
        },
        runAsync: async (source, params) => {
            const connection = await database();

            return connection.runAsync(source, params ?? []);
        },
        withTransactionAsync: async (task) => {
            const connection = await database();

            await connection.withTransactionAsync(task);
        },
    });

    return cache;
};
