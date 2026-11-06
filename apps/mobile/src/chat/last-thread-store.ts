import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";

import type { LastThread } from "./last-thread";
import { isReopenOn, parseLastThread, reopenValue, threadToReopen } from "./last-thread";

const LAST_THREAD_KEY = "neore.mobile.last-thread";
const REOPEN_KEY = "neore.mobile.reopen-last-chat";

/** Records the chat on screen. The OS keeps it out of the app's data folder, like the sign-in grant. */
export const rememberLastThread = async (last: LastThread): Promise<void> => {
    await setItemAsync(LAST_THREAD_KEY, JSON.stringify(last));
};

/** Forgets the saved chat, such as one the server no longer lets this account open. */
export const forgetLastThread = async (): Promise<void> => {
    await deleteItemAsync(LAST_THREAD_KEY);
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
