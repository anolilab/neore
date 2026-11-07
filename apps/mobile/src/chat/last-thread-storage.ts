import { createSerialQueue } from "../lib/serial-queue";
import type { LastThread } from "./last-thread";
import { isReopenOn, isSavedThread, parseLastThread, reopenValue, threadToReopen } from "./last-thread";

/** The key-value store the saved chat lives in. The app passes expo-secure-store; tests pass a Map. */
export interface KeyValueStore {
    deleteItem: (key: string) => Promise<void>;
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
}

export const LAST_THREAD_KEY = "neore.mobile.last-thread";
export const REOPEN_KEY = "neore.mobile.reopen-last-chat";

export interface LastThreadStore {
    /** Forgets the saved chat of every account, whatever it is: used once nobody is signed in. */
    clearLastThread: () => Promise<void>;
    /** Forgets the saved chat, but only while it is `target`: a chat saved since then, or by another account, is not the refused one. */
    forgetLastThread: (target: LastThread) => Promise<void>;
    /** The chat to open at launch for `userId`, if any. A store that cannot be read opens nothing. */
    lastChatToReopen: (userId: string) => Promise<string | undefined>;
    readReopenLastChat: () => Promise<boolean>;
    /** Saves the chat this account has read. */
    rememberLastThread: (last: LastThread) => Promise<void>;
    writeReopenLastChat: (isOn: boolean) => Promise<void>;
}

/** Reads and writes the last viewed chat and the reopen setting in `store`. */
export const createLastThreadStore = (store: KeyValueStore): LastThreadStore => {
    // Saves and forgets run one after another, so a forget asked after a save always lands after it.
    const inOrder = createSerialQueue();

    return {
        clearLastThread: async (): Promise<void> => {
            await inOrder(async () => {
                await store.deleteItem(LAST_THREAD_KEY);
            });
        },

        forgetLastThread: async (target: LastThread): Promise<void> => {
            await inOrder(async () => {
                if (isSavedThread(parseLastThread(await store.getItem(LAST_THREAD_KEY)), target)) {
                    await store.deleteItem(LAST_THREAD_KEY);
                }
            });
        },

        lastChatToReopen: async (userId: string): Promise<string | undefined> => {
            try {
                const isOn = isReopenOn(await store.getItem(REOPEN_KEY));
                const last = parseLastThread(await store.getItem(LAST_THREAD_KEY));

                return threadToReopen({ isOn, last, userId });
            } catch {
                return undefined;
            }
        },

        readReopenLastChat: async (): Promise<boolean> => isReopenOn(await store.getItem(REOPEN_KEY)),

        rememberLastThread: async (last: LastThread): Promise<void> => {
            await inOrder(async () => {
                await store.setItem(LAST_THREAD_KEY, JSON.stringify(last));
            });
        },

        writeReopenLastChat: async (isOn: boolean): Promise<void> => {
            await store.setItem(REOPEN_KEY, reopenValue(isOn));
        },
    };
};
