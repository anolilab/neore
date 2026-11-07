import { describe, expect, it } from "vitest";

import type { KeyValueStore, LastThreadStore } from "./last-thread-storage";
import { createLastThreadStore, LAST_THREAD_KEY } from "./last-thread-storage";

/** A Map-backed store. `writeDelays` holds each successive write for that many ms, so writes can finish out of order. */
const memoryStore = (values = new Map<string, string>(), writeDelays: number[] = []) => {
    const writes: string[] = [];
    const store: KeyValueStore = {
        deleteItem: async (key) => {
            values.delete(key);
        },
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
            const delay = writeDelays.shift() ?? 0;

            await new Promise((resolve) => {
                setTimeout(resolve, delay);
            });
            values.set(key, value);
            writes.push(value);
        },
    };

    return { store, values, writes };
};

/** A store with `userId` signed in, as the app binds it at sign-in. */
const signedIn = (store: KeyValueStore, userId = "u-1"): LastThreadStore => {
    const lastThread = createLastThreadStore(store);

    lastThread.bindOwner(userId);

    return lastThread;
};

describe("last thread storage", () => {
    it("reads back on relaunch the chat saved before it", async () => {
        const { store } = memoryStore();

        await signedIn(store).rememberLastThread({ threadId: "t-1", userId: "u-1" });

        // A relaunch builds a new store over the same storage.
        await expect(createLastThreadStore(store).lastChatToReopen("u-1")).resolves.toBe("t-1");
    });

    it("lands rapid saves in the order they were made, so the last one wins", async () => {
        // The first save is the slowest: without the queue it would land last and win.
        const { store, writes } = memoryStore(new Map(), [30, 10, 0]);
        const lastThread = signedIn(store);

        await Promise.all([
            lastThread.rememberLastThread({ threadId: "t-1", userId: "u-1" }),
            lastThread.rememberLastThread({ threadId: "t-2", userId: "u-1" }),
            lastThread.rememberLastThread({ threadId: "t-3", userId: "u-1" }),
        ]);

        expect(writes.map((raw) => (JSON.parse(raw) as { threadId: string }).threadId)).toEqual(["t-1", "t-2", "t-3"]);
        await expect(lastThread.lastChatToReopen("u-1")).resolves.toBe("t-3");
    });

    it("opens the chat list next launch once the saved chat is refused as gone or not shared", async () => {
        const { store } = memoryStore(new Map(), [20]);
        const lastThread = signedIn(store);

        // The refusal is asked while the save is still writing: it still lands after it.
        await Promise.all([
            lastThread.rememberLastThread({ threadId: "t-gone", userId: "u-1" }),
            lastThread.forgetLastThread({ threadId: "t-gone", userId: "u-1" }),
        ]);

        await expect(createLastThreadStore(store).lastChatToReopen("u-1")).resolves.toBeUndefined();
    });

    it("keeps a chat saved after the refused one", async () => {
        const { store } = memoryStore();
        const lastThread = signedIn(store);

        await lastThread.rememberLastThread({ threadId: "t-new", userId: "u-1" });
        await lastThread.forgetLastThread({ threadId: "t-gone", userId: "u-1" });

        await expect(lastThread.lastChatToReopen("u-1")).resolves.toBe("t-new");
    });

    it("forgets the saved chat at sign-out, after any save still writing", async () => {
        const { store, values } = memoryStore(new Map(), [20]);
        const lastThread = signedIn(store);

        await Promise.all([lastThread.rememberLastThread({ threadId: "t-1", userId: "u-1" }), lastThread.clearLastThread()]);

        expect(values.has(LAST_THREAD_KEY)).toBe(false);
        await expect(lastThread.lastChatToReopen("u-1")).resolves.toBeUndefined();
    });

    it("drops a save from a read that outlives the session, so the cleared chat is not written back", async () => {
        const { store, values } = memoryStore();
        const lastThread = signedIn(store);

        await lastThread.clearLastThread();
        await lastThread.rememberLastThread({ threadId: "t-1", userId: "u-1" });

        expect(values.has(LAST_THREAD_KEY)).toBe(false);
    });

    it("saves only for the signed-in account", async () => {
        const { store, values } = memoryStore();
        const lastThread = signedIn(store, "u-2");

        await lastThread.rememberLastThread({ threadId: "t-1", userId: "u-1" });

        expect(values.has(LAST_THREAD_KEY)).toBe(false);
    });

    it("opens nothing, without throwing, when the store cannot be read", async () => {
        const lastThread = createLastThreadStore({
            deleteItem: async () => undefined,
            getItem: async () => {
                throw new Error("keychain unavailable");
            },
            setItem: async () => undefined,
        });

        await expect(lastThread.lastChatToReopen("u-1")).resolves.toBeUndefined();
    });
});
