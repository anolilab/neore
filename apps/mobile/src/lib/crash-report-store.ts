import { getItemAsync, setItemAsync } from "expo-secure-store";

import type { PreferenceStore } from "./crash-report-preference";

const KEY = "neore.mobile.crash-reports";

/** The crash-report choice on this device. The OS keeps it out of the app's data folder. */
export const crashReportStore: PreferenceStore = {
    get: async () => getItemAsync(KEY),
    set: async (value) => {
        await setItemAsync(KEY, value);
    },
};
