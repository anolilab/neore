// @vitest-environment node
// Node: WebCrypto and a structured clone that keeps `CryptoKey`, as IndexedDB does.
import type { DehydratedState } from "@tanstack/query-core";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordStore } from "./encrypted-store";
import { entryName, openRecord, sealRecord } from "./encrypted-store";
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
        clear: async (name) => {
            stores[name].clear();
        },
        delete: async (name, key) => {
            stores[name].delete(key);

            if (name === "entries") {
                changed();
            }
        },
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

/** Runs a session with writes on, waits for its throttled save to land, and stops it. */
const saveSession = async (memory: ReturnType<typeof memoryStore>, userId: string, queryClient: QueryClient): Promise<void> => {
    const controller = start(memory.store, userId, queryClient);

    await controller.restored;

    const written = memory.settled();

    controller.enableWrites();
    await vi.advanceTimersByTimeAsync(WRITE_THROTTLE_MS);
    await written;
    controller.stop();
};

const textOf = (queryClient: QueryClient, key: unknown[]): string | undefined => (queryClient.getQueryData(key) as { text: string } | undefined)?.text;

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

        expect(await openRecord(store, ALICE)).toBe(`{"text":"${SECRET_TEXT}"}`);

        const sealed = stores.entries.get(entryName(ALICE)) as { data: ArrayBuffer };

        expect(new TextDecoder().decode(sealed.data)).not.toContain(SECRET_TEXT);
        expect(stores.keys.get(ALICE)).toMatchObject({ extractable: false });
    });

    it("keeps accounts apart: a record never opens as another account's", async () => {
        const memory = memoryStore();
        const alice = new QueryClient();

        alice.setQueryData(KEY, { text: SECRET_TEXT });
        await saveSession(memory, ALICE, alice);

        const bob = new QueryClient();

        await start(memory.store, BOB, bob).restored;
        expect(bob.getQueryCache().getAll()).toHaveLength(0);

        // Moved under Bob's name, even with Alice's key standing in for Bob's, the record's name (its additional data) refuses it.
        memory.stores.keys.set(BOB, memory.stores.keys.get(ALICE));
        memory.stores.entries.set(entryName(BOB), memory.stores.entries.get(entryName(ALICE)));
        await expect(openRecord(memory.store, BOB)).rejects.toThrow();
    });
});

describe("restore", () => {
    it("shows the kept data on the first read, marks it old, and a live value replaces it", async () => {
        const memory = memoryStore();
        const before = new QueryClient();

        before.setQueryData(KEY, { text: "kept" });
        await saveSession(memory, ALICE, before);

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

        // Nobody watches it now: it still outlives the default five-minute collection.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(textOf(queryClient, KEY)).toBe("live");
    });

    it.each([
        ["written under another schema", { buster: "2" }, 0],
        ["not written for longer than the maximum age", {}, MAX_AGE_MS + 1],
    ])("drops a record %s", async (_name, extra, age) => {
        const memory = memoryStore();
        const before = new QueryClient();

        before.setQueryData(KEY, { text: "kept" });
        await saveSession(memory, ALICE, before);
        vi.setSystemTime(Date.now() + age);

        const queryClient = new QueryClient();

        await start(memory.store, ALICE, queryClient, extra).restored;

        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
        expect(await openRecord(memory.store, ALICE)).toBeUndefined();
    });

    it("applies the policy on the way back in, so a tightened rule drops what an older save kept", async () => {
        const memory = memoryStore();
        const before = new QueryClient();

        before.setQueryData(KEY, { text: "kept" });
        before.setQueryData(OTHER_KEY, { text: "dropped" });
        await saveSession(memory, ALICE, before);

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
        const before = new QueryClient();

        before.setQueryData(KEY, { text: SECRET_TEXT });
        await saveSession(memory, ALICE, before);

        const storeGate = new EventTarget();
        const opened = nextEvent(storeGate, "open");
        const slowStore: RecordStore = {
            ...memory.store,
            get: async (name, key) => {
                await opened;

                return await memory.store.get(name, key);
            },
        };
        const { gate, writeGate } = openGate();
        const queryClient = new QueryClient();
        const controller = start(slowStore, ALICE, queryClient, { gate: writeGate });

        if (how === "stop") {
            controller.stop();
        } else {
            gate.generation += 1;
        }

        storeGate.dispatchEvent(new Event("open"));
        await controller.restored;
        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });

    it("a session that turns out impersonated or a guest drops what was restored, not what it read since", async () => {
        const memory = memoryStore();
        const before = new QueryClient();

        before.setQueryData(KEY, { text: "kept" });
        before.setQueryData(OTHER_KEY, { text: "kept" });
        await saveSession(memory, ALICE, before);

        const queryClient = new QueryClient();
        const controller = start(memory.store, ALICE, queryClient);

        await controller.restored;
        queryClient.setQueryData(OTHER_KEY, { text: "live" });
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

        queryClient.setQueryData(OTHER_KEY, { text: "alice's" });
        vi.setSystemTime(Date.now() + 1);
        await saveSession(memory, BOB, queryClient);

        const restored = new QueryClient();

        queryClient.setQueryData(KEY, { text: "bob's" });
        await saveSession(memory, BOB, queryClient);
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

        queryClient.setQueryData(KEY, { text: SECRET_TEXT });

        const controller = start(slowStore, ALICE, queryClient, { gate: writeGate });

        await controller.restored;
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
        expect(memory.stores.entries.has(entryName(ALICE))).toBe(false);
        controller.stop();
    });

    it("an unavailable or full store degrades to no cache, silently", async () => {
        const blocked = async (): Promise<never> => {
            throw new DOMException("blocked", "InvalidStateError");
        };
        const failing: RecordStore = { clear: blocked, delete: blocked, get: blocked, put: blocked, putIfAbsent: blocked };
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
