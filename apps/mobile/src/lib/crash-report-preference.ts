/** The crash-report switch as stored text: "on" or "off". Anything else reads as off. */
export interface PreferenceStore {
    get: () => Promise<string | null>;
    set: (value: string) => Promise<void>;
}

const ON = "on";
const OFF = "off";

export const readCrashReportsEnabled = async (store: PreferenceStore): Promise<boolean> => await store.get() === ON;

export const writeCrashReportsEnabled = async (store: PreferenceStore, isEnabled: boolean): Promise<void> => {
    await store.set(isEnabled ? ON : OFF);
};
