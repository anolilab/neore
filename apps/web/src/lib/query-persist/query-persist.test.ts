// @vitest-environment node
// Node: WebCrypto and a structured clone that keeps `CryptoKey`, as IndexedDB does.
import type { DehydratedState } from "@tanstack/query-core";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordStore } from "./encrypted-store";
import { indexedDatabaseStore, openRecord, pruneRecords, removeRecord, sealRecord } from "./encrypted-store";
import type { PersistPolicy, WriteGate } from "./persister";
import { MAX_AGE_MS, startQueryPersistence, WRITE_THROTTLE_MS } from "./persister";

const ALICE = "user-alice";
const BOB = "user-bob";
const SECRET_TEXT = "the plaintext the record must never hold";
const BUSTER = "1";
const KEY = ["lunora", "chat_functions:getThread", '{"threadId":"t1"}', null];
const OTHER_KEY = ["lunora", "auth_functions:getUserSettings", "{}", null];

/** Resolves the next time `target` fires `type`. */
const nextEvent = async (target: EventTarget, type: string): Promise<void> => {
    await new Promise((resolve) => {
        target.addEventListener(type, resolve, { once: true });
    });
};

/** An in-memory IndexedDB stand-in: values go through structured clone, as IndexedDB stores them. `settled` resolves on the next record write or delete. */
const memoryStore = () => {
    const stores = { entries: new Map<string, unknown>(), keys: new Map<string, unknown>() };
    const events = new EventTarget();
    const changed = (): void => {
        events.dispatchEvent(new Event("change"));
    };
    const store: RecordStore = {
        get: async (name, key) => structuredClone(stores[name].get(key)),
        putEntry: async (userId, entry, mayReplace) => {
            if (!mayReplace(structuredClone(stores.keys.get(userId)), structuredClone(stores.entries.get(userId)))) {
                return false;
            }

            stores.entries.set(userId, structuredClone(entry));
            changed();

            return true;
        },
        putIfAbsent: async (name, key, value) => {
            if (!stores[name].has(key)) {
                stores[name].set(key, structuredClone(value));
            }

            return structuredClone(stores[name].get(key));
        },
        remove: async (userIds, shouldRemove) => {
            const candidates = userIds ?? [...stores.entries.keys()];

            for (const userId of candidates) {
                if (shouldRemove !== undefined && !shouldRemove(structuredClone(stores.entries.get(userId)))) {
                    continue;
                }

                stores.entries.delete(userId);
                stores.keys.delete(userId);
                changed();
            }

            // As the IndexedDB store: a prune also offers the keys no entry belongs to.
            if (userIds === undefined && shouldRemove !== undefined) {
                for (const [userId, key] of stores.keys) {
                    if (stores.entries.has(userId) || !shouldRemove(undefined, key)) {
                        continue;
                    }

                    stores.keys.delete(userId);
                    changed();
                }
            }
        },
    };

    return { settled: async () => await nextEvent(events, "change"), store, stores };
};

/** Keeps every settled query; `sanitize` is swapped per test. */
const keepAll = (sanitize: PersistPolicy["sanitize"] = (state) => state): PersistPolicy => {
    return { sanitize, select: () => (query) => query.state.status === "success" };
};

const openGate = () => {
    const gate = { allowed: true, generation: 0 };
    const writeGate: WriteGate = { canWrite: () => gate.allowed, generation: () => gate.generation };

    return { gate, writeGate };
};

const start = (store: RecordStore, userId: string, queryClient: QueryClient, extra: { buster?: string; gate?: WriteGate; policy?: PersistPolicy } = {}) =>
    startQueryPersistence({
        buster: extra.buster ?? BUSTER,
        gate: extra.gate ?? openGate().writeGate,
        policy: extra.policy ?? keepAll(),
        queryClient,
        store,
        userId,
    });

/** Runs a session that reads `fill` once started, with writes on; waits for its throttled save to land, and stops it. */
const saveSession = async (
    memory: ReturnType<typeof memoryStore>,
    userId: string,
    queryClient: QueryClient,
    fill: (queryClient: QueryClient) => void,
): Promise<void> => {
    const controller = start(memory.store, userId, queryClient);

    await controller.restored;
    fill(queryClient);

    const written = memory.settled();

    controller.enableWrites();
    await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
    await written;
    controller.stop();
};

const textOf = (queryClient: QueryClient, key: unknown[]): string | undefined => (queryClient.getQueryData(key) as { text: string } | undefined)?.text;

/** Saves `{ text }` under each key as `userId`'s record. */
const saveTexts = async (memory: ReturnType<typeof memoryStore>, userId: string, texts: ReadonlyArray<[unknown[], string]>): Promise<void> => {
    await saveSession(memory, userId, new QueryClient(), (queryClient) => {
        for (const [key, text] of texts) {
            queryClient.setQueryData(key, { text });
        }
    });
};

/** A store whose reads of `name` wait until `release()`; `reached` resolves when the first one is waiting. */
const heldReads = (store: RecordStore, name: "entries" | "keys") => {
    const gate = new EventTarget();
    const released = nextEvent(gate, "open");
    const reached = nextEvent(gate, "reached");

    return {
        reached,
        release: () => {
            gate.dispatchEvent(new Event("open"));
        },
        store: {
            ...store,
            get: async (storeName, key) => {
                if (storeName === name) {
                    gate.dispatchEvent(new Event("reached"));
                    await released;
                }

                return await store.get(storeName, key);
            },
        } satisfies RecordStore,
    };
};

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-12T10:00:00Z"), toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("encryption", () => {
    it("round-trips under a non-extractable key, and the stored bytes hold no plaintext", async () => {
        const { store, stores } = memoryStore();

        await sealRecord(store, ALICE, `{"text":"${SECRET_TEXT}"}`);

        const opened = await openRecord(store, ALICE);

        expect(opened?.text).toBe(`{"text":"${SECRET_TEXT}"}`);

        const sealed = stores.entries.get(ALICE) as { data: ArrayBuffer };

        expect(new TextDecoder().decode(sealed.data)).not.toContain(SECRET_TEXT);
        expect(stores.keys.get(ALICE)).toMatchObject({ key: { extractable: false } });
    });

    it("keeps accounts apart: a record never opens as another account's", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [[KEY, SECRET_TEXT]]);

        const bob = new QueryClient();

        await start(memory.store, BOB, bob).restored;
        expect(bob.getQueryCache().getAll()).toHaveLength(0);

        // Moved under Bob's name, even with Alice's key standing in for Bob's, the record's name (its additional data) refuses it.
        memory.stores.keys.set(BOB, memory.stores.keys.get(ALICE));
        memory.stores.entries.set(BOB, memory.stores.entries.get(ALICE));
        const moved = await openRecord(memory.store, BOB);

        expect(moved?.text).toBeUndefined();
    });
});

describe("restore", () => {
    it("shows the kept data on the first read, marks it old, and a live value replaces it", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [
            [KEY, "kept"],
            [OTHER_KEY, "kept"],
        ]);

        // The browser's default gcTime (Node's is infinite, as on a server).
        const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 5 * 60 * 1000 } } });

        // Already in the cache, older and unwatched: `hydrate` replaces its data but not its five-minute collection.
        queryClient.setQueryData(OTHER_KEY, { text: "older" }, { updatedAt: Date.now() - 60_000 });
        await start(memory.store, ALICE, queryClient).restored;

        const observer = new QueryObserver(queryClient, { enabled: false, queryKey: KEY });
        const unsubscribe = observer.subscribe(() => undefined);

        expect((observer.getCurrentResult().data as { text: string }).text).toBe("kept");
        // A live read's `staleTime` is infinite: only this makes a screen that mounts it fetch.
        expect(queryClient.getQueryState(KEY)?.isInvalidated).toBe(true);

        queryClient.setQueryData(KEY, { text: "live" });
        await start(memory.store, ALICE, queryClient).restored;
        expect(textOf(queryClient, KEY)).toBe("live");
        unsubscribe();

        // Nobody watches either now: both outlive the default five-minute collection, the restored one untouched, though it
        // was in the cache before the restore.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(textOf(queryClient, KEY)).toBe("live");
        expect(textOf(queryClient, OTHER_KEY)).toBe("kept");
    });

    it.each([
        ["written under another schema", { buster: "2" }, 0],
        ["not written for longer than the maximum age", {}, MAX_AGE_MS + 1],
    ])("drops a record %s", async (_name, extra, age) => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [[KEY, "kept"]]);
        vi.setSystemTime(Date.now() + age);

        const queryClient = new QueryClient();

        await start(memory.store, ALICE, queryClient, extra).restored;

        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
        expect(await openRecord(memory.store, ALICE)).toBeUndefined();
    });

    it("applies the policy on the way back in, so a tightened rule drops what an older save kept", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [
            [KEY, "kept"],
            [OTHER_KEY, "dropped"],
        ]);

        const onlyKey = (state: DehydratedState): DehydratedState => {
            return { ...state, queries: state.queries.filter((query) => query.queryKey[1] === KEY[1]) };
        };
        const queryClient = new QueryClient();

        await start(memory.store, ALICE, queryClient, { policy: keepAll(onlyKey) }).restored;

        expect(textOf(queryClient, KEY)).toBe("kept");
        expect(queryClient.getQueryData(OTHER_KEY)).toBeUndefined();
    });

    it.each([
        ["stopped (an account switch)", "stop"],
        ["cleared (a sign-out)", "clear"],
    ])("a restore still reading the record when the session is %s shows nothing", async (_name, how) => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [[KEY, SECRET_TEXT]]);

        const held = heldReads(memory.store, "entries");
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(held.store, ALICE, queryClient, { gate: writeGate });

        if (how === "stop") {
            controller.stop();
        } else {
            gate.generation += 1;
        }

        held.release();
        await controller.restored;
        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });

    it.each([
        ["another tab", false],
        ["a newer session of this tab", true],
    ])("dropping an old record never takes one %s wrote after it was read", async (_name, isStopped) => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [[KEY, "old"]]);
        vi.setSystemTime(Date.now() + MAX_AGE_MS + 1);

        // The old record is read; its key read waits while a fresh record lands under the same key.
        const held = heldReads(memory.store, "keys");
        const controller = start(held.store, ALICE, new QueryClient());

        await held.reached;

        if (isStopped) {
            controller.stop();
        }

        await sealRecord(memory.store, ALICE, "fresh");
        held.release();
        await controller.restored;

        const kept = await openRecord(memory.store, ALICE);

        expect(kept?.text).toBe("fresh");
    });

    it("drops an account's record not written for longer than the maximum age when another account starts", async () => {
        const memory = memoryStore();

        await saveTexts(memory, BOB, [[KEY, "bob's"]]);
        vi.setSystemTime(Date.now() + MAX_AGE_MS / 2);
        await saveTexts(memory, ALICE, [[KEY, "alice's"]]);
        vi.setSystemTime(Date.now() + MAX_AGE_MS / 2 + 1);

        await start(memory.store, ALICE, new QueryClient()).restored;

        expect(memory.stores.entries.has(BOB)).toBe(false);
        expect(memory.stores.keys.has(BOB)).toBe(false);
        expect(memory.stores.entries.has(ALICE)).toBe(true);
    });

    it("a read that arrives while the record is read is never replaced by it, even when stamped earlier", async () => {
        const memory = memoryStore();
        const savedAt = Date.now();

        await saveTexts(memory, ALICE, [[KEY, "kept"]]);

        const held = heldReads(memory.store, "entries");
        const queryClient = new QueryClient();
        const controller = start(held.store, ALICE, queryClient);

        await held.reached;
        // A server-stamped or clock-skewed live read: older than the saved value, but this session's.
        queryClient.setQueryData(KEY, { text: "live" }, { updatedAt: savedAt - 1 });
        held.release();
        await controller.restored;
        expect(textOf(queryClient, KEY)).toBe("live");

        // Not counted as restored either: a revoke keeps it.
        controller.revoke();
        await controller.restored;
        expect(textOf(queryClient, KEY)).toBe("live");
    });

    it("a session that turns out impersonated or a guest drops what was restored, not what it read since", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [
            [KEY, "kept"],
            [OTHER_KEY, "kept"],
        ]);

        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient);

        await controller.restored;
        // Stamped the same millisecond as the restored value: still a read of this session's.
        queryClient.setQueryData(OTHER_KEY, { text: "live" }, { updatedAt: queryClient.getQueryState(OTHER_KEY)?.dataUpdatedAt });
        controller.revoke();
        await controller.restored;

        expect(queryClient.getQueryData(KEY)).toBeUndefined();
        expect(textOf(queryClient, OTHER_KEY)).toBe("live");
    });

    it("a screen already showing an entry when it is restored fetches it at once", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [[KEY, "kept"]]);

        const queryClient = new QueryClient();
        let fetches = 0;
        const observer = new QueryObserver(queryClient, {
            queryFn: async () => {
                fetches += 1;

                if (fetches === 1) {
                    throw new Error("offline");
                }

                return { text: "live" };
            },
            queryKey: KEY,
            retry: false,
            staleTime: Infinity,
        });
        // Mounted before the restore: its mount fetch has failed, so the restored value replaces the empty entry it shows.
        const unsubscribe = observer.subscribe(() => undefined);

        await vi.advanceTimersByTimeAsync(0);
        expect(observer.getCurrentResult().status).toBe("error");

        await start(memory.store, ALICE, queryClient).restored;
        await vi.advanceTimersByTimeAsync(0);

        expect(fetches).toBe(2);
        expect((observer.getCurrentResult().data as { text: string }).text).toBe("live");
        unsubscribe();
    });
});

describe("saving", () => {
    it("never saves what was read before this account's session started (the previous account's, across a switch)", async () => {
        const memory = memoryStore();
        const queryClient = new QueryClient();

        // Read under Alice's token in the very millisecond Bob's session starts.
        queryClient.setQueryData(OTHER_KEY, { text: "alice's" });
        queryClient.setQueryData(KEY, { text: "alice's" });
        await saveSession(memory, BOB, queryClient, (client) => {
            client.setQueryData(KEY, { text: "bob's" });
        });

        const restored = new QueryClient();

        await start(memory.store, BOB, restored).restored;

        expect(textOf(restored, KEY)).toBe("bob's");
        expect(restored.getQueryData(OTHER_KEY)).toBeUndefined();
    });

    it("saves nothing while the gate is closed or before writes are enabled", async () => {
        const memory = memoryStore();
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient, { gate: writeGate });

        await controller.restored;
        queryClient.setQueryData(KEY, { text: "unconfirmed" });
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS * 2);
        expect(memory.stores.entries.size).toBe(0);

        gate.allowed = false;
        controller.enableWrites();
        queryClient.setQueryData(KEY, { text: "held" });
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS * 2);
        expect(memory.stores.entries.size).toBe(0);
        controller.stop();
    });

    it("a record held back while the gate was closed is restored before the first save once it opens, never replaced by less", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [
            [KEY, "kept"],
            [OTHER_KEY, "kept"],
        ]);

        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();

        gate.allowed = false;

        const controller = start(memory.store, ALICE, queryClient, { gate: writeGate });

        await controller.restored;
        expect(queryClient.getQueryData(OTHER_KEY)).toBeUndefined();

        controller.enableWrites();
        queryClient.setQueryData(KEY, { text: "live" });
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS * 2);

        expect(memory.stores.entries.get(ALICE)).toBeDefined();

        const written = { done: false };

        void (async () => {
            await memory.settled();
            written.done = true;
        })();
        gate.allowed = true;
        queryClient.setQueryData(KEY, { text: "live again" });

        // The restore runs first (WebCrypto, not a timer), then the throttled save: step the clock until it lands.
        while (!written.done) {
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        expect(textOf(queryClient, OTHER_KEY)).toBe("kept");
        expect(textOf(queryClient, KEY)).toBe("live again");
        controller.stop();

        const next = new QueryClient();

        await start(memory.store, ALICE, next).restored;
        expect(textOf(next, KEY)).toBe("live again");
        expect(textOf(next, OTHER_KEY)).toBe("kept");
    });

    it("saves a change made after a clear even though a save from before it was still queued", async () => {
        const memory = memoryStore();
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient, { gate: writeGate });

        await controller.restored;
        controller.enableWrites();
        queryClient.setQueryData(OTHER_KEY, { text: "before" });
        // A clear while that save waits on its throttle, then a new read.
        gate.generation += 1;
        queryClient.setQueryData(KEY, { text: "after" });

        const written = { done: false };

        void (async () => {
            await memory.settled();
            written.done = true;
        })();

        while (!written.done) {
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        controller.stop();

        const next = new QueryClient();

        await start(memory.store, ALICE, next).restored;
        expect(textOf(next, KEY)).toBe("after");
    });

    it("prunes a key left without a record once it is past the age limit, and keeps a new one", async () => {
        const memory = memoryStore();

        const key = await crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

        memory.stores.keys.set("orphan", { createdAt: Date.now() - MAX_AGE_MS - 1, id: "a", key });
        memory.stores.keys.set("fresh", { createdAt: Date.now(), id: "b", key });

        await pruneRecords(memory.store, Date.now() - MAX_AGE_MS);

        expect([...memory.stores.keys.keys()]).toStrictEqual(["fresh"]);
    });

    it("saves a change the closed gate held back once the gate says it opened", async () => {
        const memory = memoryStore();
        const listeners = new Set<() => void>();
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient, {
            gate: {
                ...writeGate,
                subscribe: (listener) => {
                    listeners.add(listener);

                    return () => listeners.delete(listener);
                },
            },
        });

        await controller.restored;
        controller.enableWrites();
        gate.allowed = false;
        queryClient.setQueryData(KEY, { text: "held" });
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS * 2);
        expect(memory.stores.entries.size).toBe(0);

        const written = { done: false };

        void (async () => {
            await memory.settled();
            written.done = true;
        })();
        gate.allowed = true;

        for (const listener of listeners) {
            listener();
        }

        while (!written.done) {
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        controller.stop();

        const next = new QueryClient();

        await start(memory.store, ALICE, next).restored;
        expect(textOf(next, KEY)).toBe("held");
    });

    it("drops a record holding a malformed read, and saves again", async () => {
        const memory = memoryStore();

        await sealRecord(
            memory.store,
            ALICE,
            JSON.stringify({ buster: BUSTER, clientState: { mutations: [], queries: [{ queryKey: KEY }] }, timestamp: Date.now(), userId: ALICE }),
            Date.now(),
        );

        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient);

        await controller.restored;
        controller.enableWrites();

        const written = { done: false };

        void (async () => {
            await memory.settled();
            written.done = true;
        })();
        queryClient.setQueryData(KEY, { text: "fresh" });

        while (!written.done) {
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        controller.stop();

        const next = new QueryClient();

        await start(memory.store, ALICE, next).restored;
        expect(textOf(next, KEY)).toBe("fresh");
    });

    it("saves over a record stamped by a clock that was later set back", async () => {
        const memory = memoryStore();

        // Saved while the clock ran an hour ahead.
        await sealRecord(memory.store, ALICE, "from the future", Date.now() + 60 * 60 * 1000);

        await expect(sealRecord(memory.store, ALICE, "now", Date.now())).resolves.toBeDefined();
        await expect(openRecord(memory.store, ALICE)).resolves.toMatchObject({ text: "now" });
    });

    it("does not carry a read older than the age limit into a new record", async () => {
        const memory = memoryStore();
        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient);

        await controller.restored;
        controller.enableWrites();

        const written = { done: false };

        void (async () => {
            await memory.settled();
            written.done = true;
        })();
        queryClient.setQueryData(OTHER_KEY, { text: "old" }, { updatedAt: Date.now() - MAX_AGE_MS - 1 });
        queryClient.setQueryData(KEY, { text: "fresh" });

        while (!written.done) {
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        controller.stop();

        // Not only hidden on restore: the stored record itself holds no expired read.
        const opened = await openRecord(memory.store, ALICE);
        const stored = JSON.parse(opened?.text ?? "{}") as { clientState?: DehydratedState };

        expect(stored.clientState?.queries.map((query) => query.queryKey)).toStrictEqual([KEY]);
    });

    it("a record the store failed to read is never replaced by a save, and is restored on the next try", async () => {
        const memory = memoryStore();

        await saveTexts(memory, ALICE, [
            [KEY, "kept"],
            [OTHER_KEY, "kept"],
        ]);

        const reads = { failing: true };
        const store: RecordStore = {
            ...memory.store,
            get: async (name, key) => {
                if (name === "entries" && reads.failing) {
                    throw new DOMException("busy", "UnknownError");
                }

                return await memory.store.get(name, key);
            },
        };
        const queryClient = new QueryClient();
        const controller = start(store, ALICE, queryClient);

        await controller.restored;
        controller.enableWrites();
        queryClient.setQueryData(KEY, { text: "live" });
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS * 3);

        // Nothing saved over the unread record: it still holds both queries.
        reads.failing = false;

        const before = new QueryClient();

        await start(memory.store, ALICE, before).restored;
        expect(textOf(before, OTHER_KEY)).toBe("kept");

        // The next change reads it now, then saves it with the live value.
        const written = { done: false };

        void (async () => {
            await memory.settled();
            written.done = true;
        })();
        queryClient.setQueryData(KEY, { text: "live again" });

        while (!written.done) {
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        expect(textOf(queryClient, OTHER_KEY)).toBe("kept");
        controller.stop();
    });

    /** A session whose save waits on the store until `release()`; `release` resolves once a removal has run after it. */
    const heldSave = async (onRemove: () => Promise<void> = async () => undefined) => {
        const memory = memoryStore();
        const storeGate = new EventTarget();
        const opened = nextEvent(storeGate, "open");
        const removals = new EventTarget();
        const puts = { count: 0 };
        const slowStore: RecordStore = {
            ...memory.store,
            putEntry: async (userId, entry, mayReplace) => {
                puts.count += 1;
                await opened;

                return await memory.store.putEntry(userId, entry, mayReplace);
            },
            remove: async (userIds, shouldRemove) => {
                await onRemove();
                await memory.store.remove(userIds, shouldRemove);
                removals.dispatchEvent(new Event("removed"));
            },
        };
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(slowStore, ALICE, queryClient, { gate: writeGate });

        await controller.restored;
        queryClient.setQueryData(KEY, { text: SECRET_TEXT });
        controller.enableWrites();
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);

        return {
            controller,
            gate,
            memory,
            open: () => {
                storeGate.dispatchEvent(new Event("open"));
            },
            puts,
            queryClient,
            // Not the restore's prune: only a removal after the save is let through counts.
            release: async () => {
                const removed = nextEvent(removals, "removed");

                storeGate.dispatchEvent(new Event("open"));
                await removed;
            },
        };
    };

    it.each([
        ["cleared (a sign-out)", "clear"],
        ["stopped (an account switch, a revoke)", "stop"],
    ])("a save being sealed when the session is %s leaves no record", async (_name, how) => {
        const { controller, gate, memory, release } = await heldSave();

        // The save is waiting on the store.
        if (how === "clear") {
            gate.generation += 1;
            gate.allowed = false;
        } else {
            controller.stop();
        }

        // The sealed record did land after it; the save takes it back out.
        await release();
        expect(memory.stores.entries.has(ALICE)).toBe(false);
        controller.stop();
    });

    it("changes while a save is sealing are saved once after it, with the latest state", async () => {
        const { controller, memory, open, puts, queryClient } = await heldSave();

        /**
         * Resolves once every save of Alice's queued in this tab so far is done: dropping an unreadable record of hers
         * (from a store of its own) queues behind them.
         */
        const drained = async (): Promise<void> => {
            const other = memoryStore();

            other.stores.entries.set(ALICE, "unreadable");

            const barrier = start(other.store, ALICE, new QueryClient());

            await barrier.restored;
            barrier.stop();
        };

        // The first save waits on the store while the cache keeps changing for several intervals.
        for (const text of ["second", "third", "fourth"]) {
            queryClient.setQueryData(KEY, { text });
            await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        }

        open();
        await drained();
        expect(puts.count).toBe(1);

        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
        await drained();
        expect(puts.count).toBe(2);
        controller.stop();

        const restored = new QueryClient();

        await start(memory.store, ALICE, restored).restored;
        expect(textOf(restored, KEY)).toBe("fourth");
    });

    it("taking a stale save back out never takes the record another tab wrote after it", async () => {
        let memoryRef: ReturnType<typeof memoryStore> | undefined;
        const { controller, gate, memory, release } = await heldSave(async () => {
            // Another tab saves between this tab's seal landing and its removal.
            if (memoryRef) {
                await sealRecord(memoryRef.store, ALICE, "fresh");
            }
        });

        memoryRef = memory;
        gate.generation += 1;
        await release();

        const kept = await openRecord(memory.store, ALICE);

        expect(kept?.text).toBe("fresh");
        controller.stop();
    });

    it("an unavailable or full store degrades to no cache, silently", async () => {
        const blocked = async (): Promise<never> => {
            throw new DOMException("blocked", "InvalidStateError");
        };
        const failing: RecordStore = { get: blocked, putEntry: blocked, putIfAbsent: blocked, remove: blocked };
        const queryClient = new QueryClient();

        queryClient.setQueryData(KEY, { text: "kept" });

        const controller = start(failing, ALICE, queryClient);

        await expect(controller.restored).resolves.toBeUndefined();
        controller.enableWrites();
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS * 2);
        expect(textOf(queryClient, KEY)).toBe("kept");
        controller.stop();
    });
});

describe("IndexedDB store", () => {
    beforeEach(() => {
        vi.stubGlobal("indexedDB", new IDBFactory());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ["removed", undefined],
        ["removed and made anew by another tab", "fresh"],
    ])("a seal whose key is %s before its record is written writes nothing", async (_name, otherTab) => {
        const store = indexedDatabaseStore();

        expect(store).toBeDefined();

        if (!store) {
            return;
        }

        await sealRecord(store, ALICE, "first");

        // The key is read, then a clear (and maybe another tab's save) lands before the record is written.
        const racing: RecordStore = {
            ...store,
            get: async (name, key) => {
                const value = await store.get(name, key);

                if (name === "keys") {
                    await removeRecord(store, key);

                    if (otherTab !== undefined) {
                        await sealRecord(store, ALICE, otherTab);
                    }
                }

                return value;
            },
        };

        await expect(sealRecord(racing, ALICE, SECRET_TEXT)).resolves.toBeUndefined();

        const kept = await openRecord(store, ALICE);

        expect(kept?.text).toBe(otherTab);
    });

    it("prunes, in IndexedDB, a key no record belongs to once it is past the age limit, and keeps a sealed account", async () => {
        const store = indexedDatabaseStore();

        expect(store).toBeDefined();

        if (!store) {
            return;
        }

        await sealRecord(store, ALICE, "kept");

        const key = await crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

        await store.putIfAbsent("keys", "orphan", { createdAt: Date.now() - MAX_AGE_MS - 1, id: "orphan", key });
        await pruneRecords(store, Date.now() - MAX_AGE_MS);

        await expect(store.get("keys", "orphan")).resolves.toBeUndefined();
        await expect(openRecord(store, ALICE)).resolves.toMatchObject({ text: "kept" });
    });

    it("a slow tab's older state never replaces a record another tab took later", async () => {
        const store = indexedDatabaseStore();

        expect(store).toBeDefined();

        if (!store) {
            return;
        }

        // The other tab's record is no later than now; this tab's state was taken a millisecond before it.
        const takenAt = Date.now();

        await sealRecord(store, ALICE, "newer", takenAt);
        await expect(sealRecord(store, ALICE, "older", takenAt - 1)).resolves.toBeUndefined();
        await expect(openRecord(store, ALICE)).resolves.toMatchObject({ text: "newer" });

        // Taken the same millisecond: as fresh, so it is written.
        await expect(sealRecord(store, ALICE, "as fresh", takenAt)).resolves.toBeDefined();
        await expect(openRecord(store, ALICE)).resolves.toMatchObject({ text: "as fresh" });
    });
});
