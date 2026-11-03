import { describe, expect, it } from "vitest";

import type { PreferenceStore } from "./crash-report-preference";
import { readCrashReportsEnabled, writeCrashReportsEnabled } from "./crash-report-preference";

const memoryStore = (initial: string | null = null): PreferenceStore & { value: string | null } => {
    const store = {
        get: async () => store.value,
        set: async (value: string) => {
            store.value = value;
        },
        value: initial,
    };

    return store;
};

describe("crash report preference", () => {
    it("is off when nothing has been stored", async () => {
        await expect(readCrashReportsEnabled(memoryStore())).resolves.toBe(false);
    });

    it("reads anything other than the stored on value as off", async () => {
        await expect(readCrashReportsEnabled(memoryStore("yes"))).resolves.toBe(false);
    });

    it("round-trips on and off", async () => {
        const store = memoryStore();

        await writeCrashReportsEnabled(store, true);
        await expect(readCrashReportsEnabled(store)).resolves.toBe(true);

        await writeCrashReportsEnabled(store, false);
        await expect(readCrashReportsEnabled(store)).resolves.toBe(false);
    });
});
