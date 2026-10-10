import { useEffect, useState } from "react";

export interface ExtensionSettings {
    /** Model for new chats; unset means the app-wide default. */
    defaultModelId?: string;
    /** BCP 47 tag the Translate quick action targets; unset means the browser's UI language. */
    translateLanguage?: string;
}

const KEY = "neore.settings";

/** `chrome.storage.sync`: follows the user across their signed-in browsers, holds nothing secret. */
export const readSettings = async (): Promise<ExtensionSettings> => {
    const stored = await chrome.storage.sync.get(KEY);

    return (stored[KEY] as ExtensionSettings | undefined) ?? {};
};

export const updateSettings = async (patch: Partial<ExtensionSettings>): Promise<void> => {
    const current = await readSettings();

    await chrome.storage.sync.set({ [KEY]: { ...current, ...patch } });
};

export const browserLanguage = (): string => chrome.i18n?.getUILanguage?.() ?? navigator.language ?? "en";

/** Live settings: `undefined` until the first read lands. */
export const useSettings = (): ExtensionSettings | undefined => {
    const [settings, setSettings] = useState<ExtensionSettings>();

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            const value = await readSettings();

            if (!cancelled) {
                setSettings(value);
            }
        };

        void load();

        const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "sync" && Object.hasOwn(changes, KEY)) {
                setSettings((changes[KEY]?.newValue as ExtensionSettings | undefined) ?? {});
            }
        };

        chrome.storage.onChanged.addListener(listener);

        return () => {
            cancelled = true;
            chrome.storage.onChanged.removeListener(listener);
        };
    }, []);

    return settings;
};
