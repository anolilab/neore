import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";

import { createLastThreadStore } from "./last-thread-storage";

/**
 * The saved chat in expo-secure-store: the OS keeps it out of the app's data folder, like the sign-in grant. The rules
 * live in `last-thread-storage.ts`, which takes the store as an argument so it tests without the native module.
 */
export const { clearLastThread, forgetLastThread, lastChatToReopen, readReopenLastChat, rememberLastThread, writeReopenLastChat } = createLastThreadStore({
    deleteItem: deleteItemAsync,
    getItem: getItemAsync,
    setItem: setItemAsync,
});
