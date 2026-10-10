import { create } from "zustand";

/**
 * Which messages show a translation, in which language, and whether it is
 * collapsed. The action bar opens and closes an entry; the panel under the
 * message renders it. The translation text itself lives in the TanStack Query
 * cache (keyed by message, language and text), so switching back to a language
 * already fetched is instant.
 */
export interface TranslationEntry {
    collapsed: boolean;
    language: string;
}

interface TranslationState {
    close: (messageId: string) => void;
    entries: Readonly<Record<string, TranslationEntry>>;
    open: (messageId: string, language: string) => void;
    setLanguage: (messageId: string, language: string) => void;
    toggleCollapsed: (messageId: string) => void;
}

const withEntry = (
    entries: Readonly<Record<string, TranslationEntry>>,
    messageId: string,
    update: (entry: TranslationEntry) => TranslationEntry,
): Readonly<Record<string, TranslationEntry>> => {
    const entry = entries[messageId];

    return entry ? { ...entries, [messageId]: update(entry) } : entries;
};

export const useTranslationStore = create<TranslationState>()((set) => {
    return {
        close: (messageId) =>
            set((state) => {
                return { entries: Object.fromEntries(Object.entries(state.entries).filter(([id]) => id !== messageId)) };
            }),
        entries: {},
        open: (messageId, language) =>
            set((state) => {
                return { entries: { ...state.entries, [messageId]: { collapsed: false, language } } };
            }),
        setLanguage: (messageId, language) =>
            set((state) => {
                return {
                    entries: withEntry(state.entries, messageId, (entry) => {
                        return { ...entry, collapsed: false, language };
                    }),
                };
            }),
        toggleCollapsed: (messageId) =>
            set((state) => {
                return {
                    entries: withEntry(state.entries, messageId, (entry) => {
                        return { ...entry, collapsed: !entry.collapsed };
                    }),
                };
            }),
    };
});

/**
 * Target languages offered in the picker: the app's own locales plus the most
 * spoken others. The UI locale is always present (it is the default).
 */
export const TRANSLATION_LANGUAGES: ReadonlyArray<string> = ["ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "uk", "zh"];

const LANGUAGE_SUBTAG = /^[a-z]{2,3}$/u;

/** The default target: the UI locale's language. */
export const defaultTranslationLanguage = (locale: string | undefined): string => {
    const language = locale?.split("-", 1)[0]?.toLowerCase();

    return language && LANGUAGE_SUBTAG.test(language) ? language : "en";
};

/** The picker's options for a UI locale: {@link TRANSLATION_LANGUAGES}, plus the locale's language if missing. */
export const translationLanguageOptions = (locale: string | undefined): string[] => {
    const current = defaultTranslationLanguage(locale);

    return TRANSLATION_LANGUAGES.includes(current) ? [...TRANSLATION_LANGUAGES] : [...TRANSLATION_LANGUAGES, current].toSorted((a, b) => a.localeCompare(b));
};

/** A language's name in the UI locale ("de" → "Deutsch" in German), falling back to the code. */
export const displayLanguageName = (code: string, locale: string | undefined): string => {
    try {
        return new Intl.DisplayNames(locale ? [locale] : [], { type: "language" }).of(code) ?? code;
    } catch {
        return code;
    }
};
