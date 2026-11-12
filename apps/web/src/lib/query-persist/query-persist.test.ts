// @vitest-environment node
// Node: WebCrypto and a structured clone that keeps `CryptoKey`, as IndexedDB does.
import type { DehydratedState } from "@tanstack/query-core";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordStore } from "./encrypted-store";
import { openRecord, sealRecord } from "./encrypted-store";
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
        put: async (name, key, value) => {
            stores[name].set(key, structuredClone(value));

            if (name === "entries") {
                changed();
            }
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
        expect(stores.keys.get(ALICE)).toMatchObject({ extractable: false });
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

        // Nobody watches either now: both outlive the default five-minute collection, the restored one untouched.
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

    it("a clear that lands while a save is being sealed still leaves no record", async () => {
        const memory = memoryStore();
        const storeGate = new EventTarget();
        const opened = nextEvent(storeGate, "open");
        const slowStore: RecordStore = {
            ...memory.store,
            put: async (name, key, value) => {
                await opened;
                await memory.store.put(name, key, value);
            },
        };
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(slowStore, ALICE, queryClient, { gate: writeGate });

        await controller.restored;
        queryClient.setQueryData(KEY, { text: SECRET_TEXT });
        controller.enableWrites();
        await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);

        // The save is waiting on the store; a sign-out clears and holds.
        gate.generation += 1;
        gate.allowed = false;

        const sealed = memory.settled();

        storeGate.dispatchEvent(new Event("open"));
        await sealed;
        // The sealed record did land after the clear; the save takes it back out.
        await memory.settled();
        expect(memory.stores.entries.has(ALICE)).toBe(false);
        controller.stop();
    });

    it("an unavailable or full store degrades to no cache, silently", async () => {
        const blocked = async (): Promise<never> => {
            throw new DOMException("blocked", "InvalidStateError");
        };
        const failing: RecordStore = { get: blocked, put: blocked, putIfAbsent: blocked, remove: blocked };
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
