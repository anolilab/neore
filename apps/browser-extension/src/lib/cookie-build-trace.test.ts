import { createIndexedDbQueryCache } from "@lunora/client";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { hasCookieBuildReads } from "./cookie-build-trace";

/** The client's own read cache, holding one read made as `identity`. */
const cacheRead = async (idb: IDBFactory, identity: string | null): Promise<void> => {
    await createIndexedDbQueryCache({ indexedDB: idb }).put("threads:list::{}::", { identity, ts: 1, value: [] });
};

describe(hasCookieBuildReads, () => {
    it("finds a read the cookie build cached for a signed-in user", async () => {
        const idb = new IDBFactory();

        await cacheRead(idb, "user-1");

        await expect(hasCookieBuildReads(idb)).resolves.toBe(true);
    });

    it("finds none in a cache that holds only reads made signed out", async () => {
        const idb = new IDBFactory();

        await cacheRead(idb, null);

        await expect(hasCookieBuildReads(idb)).resolves.toBe(false);
    });

    it("finds none, and creates no database, when the cache was never written", async () => {
        const idb = new IDBFactory();

        await expect(hasCookieBuildReads(idb)).resolves.toBe(false);
        await expect(idb.databases()).resolves.toEqual([]);
    });

    it("creates no database when it is gone by the time it is opened", async () => {
        const idb = new IDBFactory();
        const listDatabases = idb.databases.bind(idb);

        // Listed, then deleted before the open: what a concurrent delete looks like.
        idb.databases = async () => [{ name: "lunora-query-cache", version: 1 }];

        await expect(hasCookieBuildReads(idb)).resolves.toBe(false);
        await expect(listDatabases()).resolves.toEqual([]);

        // And the client can still create its own cache there.
        const cache = createIndexedDbQueryCache({ indexedDB: idb });

        await cache.put("k", { identity: "user-1", ts: 1, value: 1 });
        await expect(cache.load()).resolves.toHaveLength(1);
    });

    it("finds none without IndexedDB", async () => {
        await expect(hasCookieBuildReads(undefined)).resolves.toBe(false);
    });
});
