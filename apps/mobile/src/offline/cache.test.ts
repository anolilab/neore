import { afterEach, describe, expect, it } from "vitest";

import type { OfflineCache } from "./cache";
import { createOfflineCache, MAX_MESSAGES_PER_THREAD, MAX_THREADS_WITH_MESSAGES } from "./cache";
import { createTestDatabase } from "./test-database";
import type { CachedMessage, CachedStatus, CachedThread } from "./types";

const open: { close: () => void }[] = [];

const makeCache = () => {
    const clock = { now: 1000 };
    const database = createTestDatabase();

    open.push(database);

    return { cache: createOfflineCache(database, { now: () => clock.now }), clock, database };
};

afterEach(() => {
    for (const database of open) {
        database.close();
    }

    open.length = 0;
});

const thread = (id: string, updatedAt: number, overrides: Partial<CachedThread> = {}): CachedThread => {
    return { id, status: "finish", title: `Thread ${id}`, updatedAt, ...overrides };
};

const message = (id: string, threadId: string, createdAt: number, overrides: Partial<CachedMessage> = {}): CachedMessage => {
    return { createdAt, id, role: "assistant", status: "success", text: `text ${id}`, threadId, ...overrides };
};

const status = (id: string, updatedAt: number, overrides: Partial<CachedStatus> = {}): CachedStatus => {
    return { id, kind: "host", label: "Laptop", status: "idle", updatedAt, ...overrides };
};

const owned = async (cache: OfflineCache, userId = "u1") => {
    await cache.bindOwner(userId);

    return cache.forOwner(userId);
};

describe("threads", () => {
    it("stores the list with the time it was synced and reads it back newest first", async () => {
        const { cache, clock } = makeCache();
        const scoped = await owned(cache);

        clock.now = 5000;
        await scoped.saveThreads([thread("a", 10), thread("b", 20)]);

        const rows = await scoped.loadThreads();

        expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
        expect(rows.every((row) => row.syncedAt === 5000)).toBe(true);
    });

    it("never lets an older save replace a newer cached row", async () => {
        const { cache, clock } = makeCache();
        const scoped = await owned(cache);

        clock.now = 2000;
        await scoped.saveThreads([thread("a", 200, { title: "newer" })]);
        clock.now = 3000;
        await scoped.saveThreads([thread("a", 100, { title: "older" })]);

        const [row] = await scoped.loadThreads();

        expect(row?.title).toBe("newer");
    });

    it("lets a newer save replace an older row", async () => {
        const { cache, clock } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("a", 100, { title: "old" })]);
        clock.now = 2000;
        await scoped.saveThreads([thread("a", 200, { title: "new" })]);

        const [row] = await scoped.loadThreads();

        expect(row?.title).toBe("new");
        expect(row?.syncedAt).toBe(2000);
    });

    it("keeps a cached thread that a later live page does not list", async () => {
        const { cache } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("a", 10), thread("b", 20)]);
        await scoped.saveThreads([thread("b", 20)]);

        const rows = await scoped.loadThreads();

        expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
    });
});

describe("messages", () => {
    it("keeps the last 50 messages of a thread", async () => {
        const { cache } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("t", 1)]);
        await scoped.saveMessages("t", Array.from({ length: 80 }, (_, index) => message(`m${index}`, "t", index)));

        const rows = await scoped.loadMessages("t");

        expect(rows).toHaveLength(MAX_MESSAGES_PER_THREAD);
        expect(rows[0]?.id).toBe("m30");
        expect(rows.at(-1)?.id).toBe("m79");
    });

    it("keeps messages for the 20 most recent threads only", async () => {
        const { cache } = makeCache();
        const scoped = await owned(cache);
        const ids = Array.from({ length: 25 }, (_, index) => `t${index}`);

        await scoped.saveThreads(ids.map((id, index) => thread(id, index + 1)));

        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- sequential, like opening one chat after another
            await scoped.saveMessages(id, [message(`m-${id}`, id, 1)]);
        }

        const withMessages: string[] = [];

        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- sequential, like opening one chat after another
            const stored = await scoped.loadMessages(id);

            if (stored.length > 0) {
                withMessages.push(id);
            }
        }

        expect(withMessages).toHaveLength(MAX_THREADS_WITH_MESSAGES);
        expect(withMessages).not.toContain("t0");
        expect(withMessages).toContain("t24");
    });

    it("drops a thread's messages when newer threads push it out of the top 20", async () => {
        const { cache } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("old", 1)]);
        await scoped.saveMessages("old", [message("m1", "old", 1)]);
        await scoped.saveThreads(Array.from({ length: 20 }, (_, index) => thread(`n${index}`, 100 + index)));

        expect(await scoped.loadMessages("old")).toEqual([]);
    });

    it("never lets an older save replace a newer cached message", async () => {
        const { cache, clock } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("t", 1)]);
        clock.now = 9000;
        await scoped.saveMessages("t", [message("m", "t", 5, { status: "success", text: "complete reply" })]);
        clock.now = 8000;
        await scoped.saveMessages("t", [message("m", "t", 5, { status: "streaming", text: "partial" })]);

        const [row] = await scoped.loadMessages("t");

        expect(row?.text).toBe("complete reply");
    });

    it("keeps a cached message that a later live page does not list", async () => {
        const { cache } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("t", 1)]);
        await scoped.saveMessages("t", [message("a", "t", 1), message("b", "t", 2)]);
        await scoped.saveMessages("t", [message("b", "t", 2)]);

        const rows = await scoped.loadMessages("t");

        expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    });
});

describe("statuses", () => {
    it("stores host and worker status with the time it was synced", async () => {
        const { cache, clock } = makeCache();
        const scoped = await owned(cache);

        clock.now = 4000;
        await scoped.saveStatuses([status("h1", 10, { lastSeenAt: 9, status: "busy" }), status("w1", 11, { kind: "worker", label: "Worker 1" })]);

        const rows = await scoped.loadStatuses();

        expect(rows.map((row) => row.id).toSorted((a, b) => a.localeCompare(b))).toEqual(["h1", "w1"]);
        expect(rows.find((row) => row.id === "h1")).toMatchObject({ kind: "host", lastSeenAt: 9, status: "busy", syncedAt: 4000 });
    });

    it("never lets an older status replace a newer one, and keeps one a later save omits", async () => {
        const { cache } = makeCache();
        const scoped = await owned(cache);

        await scoped.saveStatuses([status("h1", 20, { status: "idle" }), status("h2", 5)]);
        await scoped.saveStatuses([status("h1", 10, { status: "busy" })]);

        const rows = await scoped.loadStatuses();

        expect(rows.find((row) => row.id === "h1")?.status).toBe("idle");
        expect(rows.map((row) => row.id)).toContain("h2");
    });
});

describe("sign-out and account switch", () => {
    const fill = async (cache: OfflineCache) => {
        const scoped = await owned(cache);

        await scoped.saveThreads([thread("t", 1)]);
        await scoped.saveMessages("t", [message("m", "t", 1)]);
        await scoped.saveStatuses([status("h", 1)]);

        return scoped;
    };

    it("empties every cached table on clear", async () => {
        const { cache, database } = makeCache();

        await fill(cache);
        await cache.clear();

        for (const table of ["cached_threads", "cached_messages", "cached_statuses", "cache_meta"]) {
            // eslint-disable-next-line no-await-in-loop -- four small reads
            expect(await database.getAllAsync(`SELECT * FROM ${table}`), table).toEqual([]);
        }
    });

    it("refuses a save from a screen of the account that just signed out", async () => {
        const { cache } = makeCache();
        const scoped = await fill(cache);

        await cache.clear();
        await scoped.saveThreads([thread("late", 99)]);
        await scoped.saveMessages("t", [message("late", "t", 99)]);

        const next = await owned(cache, "u2");

        expect(await next.loadThreads()).toEqual([]);
        expect(await next.loadMessages("t")).toEqual([]);
    });

    it("empties the cache when a different account binds, and keeps it for the same one", async () => {
        const { cache } = makeCache();
        const scoped = await fill(cache);

        await cache.bindOwner("u1");
        expect(await scoped.loadThreads()).toHaveLength(1);

        await cache.bindOwner("u2");

        const second = await owned(cache, "u2");

        expect(await second.loadThreads()).toEqual([]);
        expect(await scoped.loadThreads()).toEqual([]);
    });

    it("reads nothing for a scope other than the bound account", async () => {
        const { cache } = makeCache();

        await fill(cache);

        expect(await cache.forOwner("someone-else").loadThreads()).toEqual([]);
    });
});

describe("read-only by construction", () => {
    it("holds only read tables: no outbox or pending-write table", async () => {
        const { cache, database } = makeCache();

        await cache.bindOwner("u1");

        const rows = await database.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

        expect(rows.map((row) => row.name)).toEqual(["cache_meta", "cached_messages", "cached_statuses", "cached_threads"]);
    });
});
