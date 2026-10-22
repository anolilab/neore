import { createInMemoryPersistence, createInMemoryQueryCache, LunoraClient } from "@lunora/client";

import { loadConfig } from "./config";

/**
 * The one Lunora client for the app. Hermes has no IndexedDB, so the browser's
 * default durable stores are replaced by in-memory ones: nothing survives a
 * restart, and the offline outbox is not durable. An expo-sqlite adapter is the
 * upgrade path (it is real work, so it is not in this slice).
 */
export const createAppClient = (url: string): LunoraClient =>
    new LunoraClient({
        persistence: createInMemoryPersistence(),
        queryCache: createInMemoryQueryCache(),
        url,
    });

let client: LunoraClient | undefined;

/** Created on first use, so a missing env var surfaces in the layout, not at import time. */
export const getClient = (): LunoraClient => {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- the lazy singleton is the point: the first call reads the config
    client ??= createAppClient(loadConfig().lunoraUrl);

    return client;
};
