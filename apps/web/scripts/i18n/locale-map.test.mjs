import { describe, expect, it } from "vitest";

import { findLocaleMaps, looksLikeLocaleMap } from "./locale-map.mjs";

const LOCALES = ["de", "en", "es", "fr"];

describe("looksLikeLocaleMap", () => {
    it("takes a map keyed by locale, in either quote, and a map with one key", () => {
        expect(looksLikeLocaleMap("{'de': 'Hallo', 'es': 'Hola'}", LOCALES)).toBe(true);
        expect(looksLikeLocaleMap('{"fr": "Bonjour", "en": "Hello"}', LOCALES)).toBe(true);
        expect(looksLikeLocaleMap(" {'de': 'Hallo'}", LOCALES)).toBe(true);
    });

    it("leaves a translation that only names a locale or holds braces", () => {
        expect(looksLikeLocaleMap("Hallo {name}", LOCALES)).toBe(false);
        expect(looksLikeLocaleMap('Set "de": the language code', LOCALES)).toBe(false);
        expect(looksLikeLocaleMap("{count, plural, one {# Datei} other {# Dateien}}", LOCALES)).toBe(false);
    });
});

describe("findLocaleMaps", () => {
    it("finds a map split over continuation lines, by the line its msgstr starts on", () => {
        const catalog = [
            'msgid ""',
            'msgstr ""',
            '"Language: de\\n"',
            "",
            "#: src/a.tsx:1",
            'msgid "Hello"',
            'msgstr "Hallo"',
            "",
            "#: src/b.tsx:2",
            'msgid "Save"',
            'msgstr ""',
            "\"{'de': 'Speichern', \"",
            "\"'es': 'Guardar'}\"",
            "",
        ].join("\n");

        expect(findLocaleMaps(catalog, LOCALES)).toStrictEqual([{ line: 11, msgid: "Save" }]);
    });
});
