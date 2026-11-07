import { getItemAsync, setItemAsync } from "expo-secure-store";

import { createDictationSetting } from "./dictation";

/** "Transcribe on this device", kept in expo-secure-store next to the app's other settings. */
export const { readOnDevice: readOnDeviceDictation, writeOnDevice: writeOnDeviceDictation } = createDictationSetting({
    getItem: getItemAsync,
    setItem: setItemAsync,
});
