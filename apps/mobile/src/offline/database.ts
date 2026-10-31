import { Paths } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";
import { openDatabaseAsync } from "expo-sqlite";

import type { OfflineCache } from "./cache";
import { createOfflineCache } from "./cache";
import { databaseDirectory } from "./database-path";
import { createLazyOpen } from "./lazy-open";

const DATABASE_NAME = "neore-offline-cache.db";

let cache: OfflineCache | undefined;
// A failed open is forgotten, so a later operation retries instead of failing for the rest of the process.
const database = createLazyOpen((): Promise<SQLiteDatabase> => openDatabaseAsync(DATABASE_NAME, undefined, databaseDirectory(Paths.cache.uri)));

/**
 * The one cache for the app, on a SQLite file in the cache directory (not the default folder, which iOS backs up to
 * iCloud and Android Auto Backup copies). The file opens on first use. Sign-out empties it, so it
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
