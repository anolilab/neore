import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";

import { createSerialQueue } from "@/lib/serial-queue";

import type { LastThread } from "./last-thread";
import { isReopenOn, isSavedThread, parseLastThread, reopenValue, threadToReopen } from "./last-thread";

const LAST_THREAD_KEY = "neore.mobile.last-thread";
const REOPEN_KEY = "neore.mobile.reopen-last-chat";

// Saves and forgets run one after another, so a forget asked after a save always lands after it.
const inOrder = createSerialQueue();

/** Saves the chat this account has read. The OS keeps it out of the app's data folder, like the sign-in grant. */
export const rememberLastThread = async (last: LastThread): Promise<void> => {
    await inOrder(async () => {
        await setItemAsync(LAST_THREAD_KEY, JSON.stringify(last));
    });
};

/** Forgets the saved chat, but only while it is `threadId`: a chat saved since then is not the refused one. */
export const forgetLastThread = async (threadId: string): Promise<void> => {
    await inOrder(async () => {
        if (isSavedThread(parseLastThread(await getItemAsync(LAST_THREAD_KEY)), threadId)) {
            await deleteItemAsync(LAST_THREAD_KEY);
        }
    });
};

export const readReopenLastChat = async (): Promise<boolean> => isReopenOn(await getItemAsync(REOPEN_KEY));

export const writeReopenLastChat = async (isOn: boolean): Promise<void> => {
    await setItemAsync(REOPEN_KEY, reopenValue(isOn));
};

/** The chat to open at launch for `userId`, if any. A store that cannot be read opens nothing. */
export const lastChatToReopen = async (userId: string): Promise<string | undefined> => {
    try {
        const isOn = isReopenOn(await getItemAsync(REOPEN_KEY));
        const last = parseLastThread(await getItemAsync(LAST_THREAD_KEY));

        return threadToReopen({ isOn, last, userId });
    } catch {
        return undefined;
    }
};
