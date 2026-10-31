import { afterEach, describe, expect, it } from "vitest";

import { createOfflineCache } from "./cache";
import { createTestDatabase } from "./test-database";
import type { ThreadPage } from "./thread-list";
import { listNotice, loadCachedThreads, OFFLINE_EMPTY_NOTICE, persistThreadPage, readLiveThreadList } from "./thread-list";
import type { ThreadRow } from "./types";

const open: { close: () => void }[] = [];

const setup = async () => {
    const database = createTestDatabase();

    open.push(database);

    const cache = createOfflineCache(database);

    await cache.bindOwner("u1");

    return cache.forOwner("u1");
};

afterEach(() => {
    for (const database of open) {
        database.close();
    }

    open.length = 0;
});

const settle = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

const row = (id: string, updatedAt: number, syncedAt: number): ThreadRow => {
    return { id, status: "finish", syncedAt, title: `Thread ${id}`, updatedAt };
};

const page = (rows: ThreadRow[], overrides: Partial<ThreadPage> = {}): ThreadPage => {
    return { continueCursor: null, isDone: true, lockedIds: new Set(), rows, ...overrides };
};

describe("a live list read that fails", () => {
    it("falls back to the saved rows, whatever the failure", async () => {
        const scoped = await setup();

        await scoped.saveThreads([{ id: "a", status: "finish", title: "Kept", updatedAt: 10 }]);

        const cached = await loadCachedThreads(scoped);
        const unreachable = await readLiveThreadList({
            cache: scoped,
            fetchFirstPage: async () => {
                throw new TypeError("Network request failed");
            },
        });
        const failed = await readLiveThreadList({
            cache: scoped,
            fetchFirstPage: async () => {
                throw new Error("Could not load chats.");
            },
        });

        expect(cached.map((thread) => thread.id)).toEqual(["a"]);
        expect(unreachable.kind).toBe("unreachable");
        expect(failed).toEqual({ kind: "failed", message: "Could not load chats." });

        const afterFailures = await loadCachedThreads(scoped);

        expect(afterFailures.map((thread) => thread.id)).toEqual(["a"]);
    });

    it("is retried on reconnect and the retry carries no error", async () => {
        const scoped = await setup();
        const failed = await readLiveThreadList({
            cache: scoped,
            fetchFirstPage: async () => {
                throw new Error("Could not load chats.");
            },
        });
        const retried = await readLiveThreadList({ cache: scoped, fetchFirstPage: async (startedAt) => page([row("a", 10, startedAt)]) });

        expect(failed.kind).toBe("failed");
        expect(retried.kind).toBe("page");
        expect(listNotice({ cacheChecked: true, isOffline: false, loadError: undefined, rowCount: 1 })).toBeUndefined();
    });
});

describe("persisting a live page", () => {
    it("saves the rows stamped with the read start, and never saves a locked thread", async () => {
        const scoped = await setup();

        persistThreadPage(scoped, page([row("a", 10, 500), row("b", 20, 500)], { lockedIds: new Set(["b"]) }), { isComplete: false, startedAt: 500 });
        await settle();

        const saved = await loadCachedThreads(scoped);

        expect(saved.map((thread) => thread.id)).toEqual(["a"]);
        expect(saved[0]?.syncedAt).toBe(500);
    });

    it("drops a cached thread the server no longer lists, but only after a complete read", async () => {
        const scoped = await setup();

        await scoped.saveThreads([{ id: "gone", status: "finish", title: "Deleted elsewhere", updatedAt: 5 }], { syncedAt: 100 });

        persistThreadPage(scoped, page([row("a", 10, 500)], { continueCursor: "next", isDone: false }), { isComplete: false, startedAt: 500 });
        await settle();

        const partial = await loadCachedThreads(scoped);

        expect(partial.map((thread) => thread.id).toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "gone"]);

        persistThreadPage(scoped, page([row("a", 10, 600)]), { isComplete: true, startedAt: 600 });
        await settle();

        const complete = await loadCachedThreads(scoped);

        expect(complete.map((thread) => thread.id)).toEqual(["a"]);
    });
});

describe("listNotice", () => {
    it("says nothing is saved only when offline with no rows and the cache was checked", () => {
        expect(listNotice({ cacheChecked: true, isOffline: true, loadError: undefined, rowCount: 0 })).toBe(OFFLINE_EMPTY_NOTICE);
        expect(listNotice({ cacheChecked: false, isOffline: true, loadError: undefined, rowCount: 0 })).toBeUndefined();
        expect(listNotice({ cacheChecked: true, isOffline: true, loadError: undefined, rowCount: 3 })).toBeUndefined();
    });

    it("ends with the outage: online again, the notice is gone", () => {
        expect(listNotice({ cacheChecked: true, isOffline: false, loadError: undefined, rowCount: 0 })).toBeUndefined();
    });

    it("shows a refusal of the read next to the rows still on screen", () => {
        expect(listNotice({ cacheChecked: true, isOffline: false, loadError: "Could not load chats.", rowCount: 4 })).toBe("Could not load chats.");
    });
});
