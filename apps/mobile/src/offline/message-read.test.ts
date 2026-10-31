import { afterEach, describe, expect, it } from "vitest";

import { createOfflineCache } from "./cache";
import { createMessageReadGate, isThreadRefusal, readOlderMessages, readThreadMessages } from "./message-read";
import { createTestDatabase } from "./test-database";
import type { MessageRow } from "./types";

const open: { close: () => void }[] = [];

const setup = async () => {
    const database = createTestDatabase();

    open.push(database);

    const cache = createOfflineCache(database);

    await cache.bindOwner("u1");

    const scoped = cache.forOwner("u1");

    await scoped.saveThreads([{ id: "t1", status: "finish", title: "Chat", updatedAt: 10 }]);

    return scoped;
};

afterEach(() => {
    for (const database of open) {
        database.close();
    }

    open.length = 0;
});

const row = (id: string, createdAt: number, syncedAt: number): MessageRow => {
    return { createdAt, id, role: "assistant", status: "success", syncedAt, text: `text ${id}`, threadId: "t1", updatedAt: createdAt };
};

const settle = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

const forbidden = () => Object.assign(new Error("This chat is locked."), { code: "FORBIDDEN", data: { code: "THREAD_LOCKED" } });

describe("a refused read", () => {
    it("drops the saved copy of a chat the server now reports as locked", async () => {
        const scoped = await setup();

        await scoped.saveMessages("t1", [{ createdAt: 1, id: "m1", role: "user", status: "success", text: "secret", threadId: "t1" }]);
        await scoped.saveStatuses([{ id: "h1", kind: "host", label: "Laptop", status: "busy", threadId: "t1", updatedAt: 5 }]);

        const result = await readThreadMessages({
            cache: scoped,
            fetchRows: async () => {
                throw forbidden();
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });

        expect(result.kind).toBe("refused");
        expect(await scoped.loadMessages("t1")).toEqual([]);
        expect(await scoped.loadStatuses()).toEqual([]);
        expect(await scoped.loadThreads()).toEqual([]);
    });

    it("keeps the saved copy when the server never answered", async () => {
        const scoped = await setup();

        await scoped.saveMessages("t1", [{ createdAt: 1, id: "m1", role: "user", status: "success", text: "kept", threadId: "t1" }]);

        const result = await readThreadMessages({
            cache: scoped,
            fetchRows: async () => {
                throw new TypeError("Network request failed");
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });

        expect(result.kind).toBe("unreachable");
        expect(await scoped.loadMessages("t1")).toHaveLength(1);
    });

    it("keeps the saved copy on a failure that is neither a network failure nor a refusal of the chat", async () => {
        const scoped = await setup();

        await scoped.saveMessages("t1", [{ createdAt: 1, id: "m1", role: "user", status: "success", text: "kept", threadId: "t1" }]);

        const result = await readThreadMessages({
            cache: scoped,
            fetchRows: async () => {
                throw Object.assign(new Error("Sign in again"), { code: "UNAUTHORIZED" });
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });

        expect(result).toEqual({ kind: "failed", message: "Sign in again" });
        expect(await scoped.loadMessages("t1")).toHaveLength(1);
    });
});

describe("overlapping reads", () => {
    it("drops a slow older read that ends after a newer one, on screen and in the cache", async () => {
        const scoped = await setup();
        const gate = createMessageReadGate();
        let releaseOlder: (rows: MessageRow[]) => void = (_rows) => undefined;
        const older = readThreadMessages({
            cache: scoped,
            fetchRows: () => new Promise((resolve) => {
                releaseOlder = (rows) => resolve({ olderCursor: null, rows });
            }),
            gate,
            now: () => 1000,
            threadId: "t1",
        });
        const newer = await readThreadMessages({
            cache: scoped,
            fetchRows: async (startedAt) => {
                return { olderCursor: null, rows: [{ ...row("m1", 1, startedAt), text: "new" }] };
            },
            gate,
            now: () => 2000,
            threadId: "t1",
        });

        expect(newer.kind).toBe("rows");

        releaseOlder([{ ...row("m1", 1, 1000), text: "old" }]);

        const olderResult = await older;

        expect(olderResult.kind).toBe("superseded");
        await settle();

        const saved = await scoped.loadMessages("t1");

        expect(saved.map((message) => message.text)).toEqual(["new"]);
    });

    it("stamps the saved rows with the moment the read started", async () => {
        const scoped = await setup();
        const clock = { now: 1000 };
        const result = await readThreadMessages({
            cache: scoped,
            fetchRows: async (startedAt) => {
                clock.now = 9000;

                return { olderCursor: null, rows: [row("m1", 1, startedAt)] };
            },
            gate: createMessageReadGate(),
            now: () => clock.now,
            threadId: "t1",
        });

        expect(result.kind).toBe("rows");
        await settle();
        const [saved] = await scoped.loadMessages("t1");

        expect(saved?.syncedAt).toBe(1000);
    });

    it("lets a read of another chat invalidate the one before it", async () => {
        const scoped = await setup();
        const gate = createMessageReadGate();
        let release: () => void = () => undefined;
        const first = readThreadMessages({
            cache: scoped,
            fetchRows: () => new Promise((resolve) => {
                release = () => resolve({ olderCursor: null, rows: [row("m1", 1, 1)] });
            }),
            gate,
            threadId: "t1",
        });

        gate.invalidate();
        release();

        const firstResult = await first;

        expect(firstResult.kind).toBe("superseded");
    });
});

describe("a revoked grant", () => {
    const revoked = () => Object.assign(new Error("Access denied to this thread"), { code: "UNAUTHORIZED" });

    it("is a refusal, unlike a lapsed sign-in", () => {
        expect(isThreadRefusal(revoked())).toBe(true);

        const lapsed = Object.assign(new Error("Please sign in to continue"), { code: "UNAUTHORIZED" });

        expect(isThreadRefusal(lapsed)).toBe(false);
    });

    it("drops the saved copy of a chat that is no longer shared", async () => {
        const scoped = await setup();

        await scoped.saveMessages("t1", [{ createdAt: 1, id: "m1", role: "user", status: "success", text: "secret", threadId: "t1" }]);

        const result = await readThreadMessages({
            cache: scoped,
            fetchRows: async () => {
                throw revoked();
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });

        expect(result.kind).toBe("refused");
        expect(await scoped.loadMessages("t1")).toEqual([]);
    });
});

describe("an older page", () => {
    const page = { olderCursor: "c2", rows: [row("m0", 1, 5)] };

    it("is returned while the chat is current", async () => {
        const scoped = await setup();

        const result = await readOlderMessages({ cache: scoped, fetchPage: async () => page, gate: createMessageReadGate(), threadId: "t1" });

        expect(result).toEqual({ kind: "page", ...page });
    });

    it("drops the saved copy when the server refuses the chat", async () => {
        const scoped = await setup();

        await scoped.saveMessages("t1", [{ createdAt: 1, id: "m1", role: "user", status: "success", text: "secret", threadId: "t1" }]);

        const result = await readOlderMessages({
            cache: scoped,
            fetchPage: async () => {
                throw forbidden();
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });

        expect(result.kind).toBe("refused");
        expect(await scoped.loadMessages("t1")).toEqual([]);
        expect(await scoped.loadThreads()).toEqual([]);
    });

    it("keeps the saved copy when the server never answered, and reports a plain failure", async () => {
        const scoped = await setup();

        await scoped.saveMessages("t1", [{ createdAt: 1, id: "m1", role: "user", status: "success", text: "kept", threadId: "t1" }]);

        const offline = await readOlderMessages({
            cache: scoped,
            fetchPage: async () => {
                throw new TypeError("Network request failed");
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });
        const broken = await readOlderMessages({
            cache: scoped,
            fetchPage: async () => {
                throw new Error("boom");
            },
            gate: createMessageReadGate(),
            threadId: "t1",
        });

        expect(offline.kind).toBe("unreachable");
        expect(broken).toEqual({ kind: "failed", message: "boom" });
        expect(await scoped.loadMessages("t1")).toHaveLength(1);
    });

    it("is dropped when the screen moved on while it loaded", async () => {
        const scoped = await setup();
        const gate = createMessageReadGate();

        const result = await readOlderMessages({
            cache: scoped,
            fetchPage: async () => {
                gate.invalidate();

                return page;
            },
            gate,
            threadId: "t1",
        });

        expect(result.kind).toBe("superseded");
    });
});
