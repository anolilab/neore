import { beforeEach, describe, expect, it } from "vitest";

import { defaultTranslationLanguage, displayLanguageName, translationLanguageOptions, useTranslationStore } from "./translation-store";

describe("translation store", () => {
    beforeEach(() => {
        useTranslationStore.setState({ entries: {} });
    });

    it("opens, switches language (expanding again), collapses and closes per message", () => {
        const { close, open, setLanguage, toggleCollapsed } = useTranslationStore.getState();

        open("m1", "de");
        toggleCollapsed("m1");
        expect(useTranslationStore.getState().entries["m1"]).toStrictEqual({ collapsed: true, language: "de" });

        setLanguage("m1", "fr");
        expect(useTranslationStore.getState().entries["m1"]).toStrictEqual({ collapsed: false, language: "fr" });

        // Actions on a message without a translation do nothing.
        setLanguage("m2", "fr");
        toggleCollapsed("m2");
        expect(useTranslationStore.getState().entries["m2"]).toBeUndefined();

        close("m1");
        expect(useTranslationStore.getState().entries).toStrictEqual({});
    });

    it("defaults to the UI locale's language", () => {
        expect(defaultTranslationLanguage("de")).toBe("de");
        expect(defaultTranslationLanguage("pt-BR")).toBe("pt");
        expect(defaultTranslationLanguage(undefined)).toBe("en");
        expect(defaultTranslationLanguage("")).toBe("en");
    });

    it("always offers the UI locale's language", () => {
        expect(translationLanguageOptions("de")).toContain("de");
        expect(translationLanguageOptions("sv")).toContain("sv");
    });

    it("names languages in the UI locale", () => {
        expect(displayLanguageName("de", "en")).toBe("German");
        expect(displayLanguageName("de", "de")).toBe("Deutsch");
    });
});
