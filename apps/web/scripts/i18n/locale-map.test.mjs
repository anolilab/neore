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
    it("finds a map split over continuation lines, by the line its msgstr starts on, and not one whose source is one too", () => {
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
            "#: src/c.tsx:3",
            'msgid "For \\"de\\": use German; for \\"fr\\": use French."',
            'msgstr "Für \\"de\\": Deutsch; für \\"fr\\": Französisch."',
            "",
        ].join("\n");

        expect(findLocaleMaps(catalog, LOCALES)).toStrictEqual([{ line: 11, msgid: "Save" }]);
    });

    it("finds a map pasted over the translation of a source that opens with an ICU placeholder", () => {
        const catalog = [
            'msgid ""',
            'msgstr ""',
            '"Language: de\\n"',
            "",
            "#: src/d.tsx:4",
            'msgid "{count} files"',
            "msgstr \"{'de': '{count} Dateien', 'fr': '{count} fichiers'}\"",
            "",
        ].join("\n");

        expect(findLocaleMaps(catalog, LOCALES)).toStrictEqual([{ line: 7, msgid: "{count} files" }]);
    });

    it("finds a map pasted over the translation of a source that names quoted locales in prose", () => {
        const catalog = [
            'msgid ""',
            'msgstr ""',
            '"Language: de\\n"',
            "",
            "#: src/c.tsx:3",
            'msgid "For \\"de\\": use German; for \\"fr\\": use French."',
            "msgstr \"{'de': 'Deutsch', 'fr': 'Französisch'}\"",
            "",
        ].join("\n");

        expect(findLocaleMaps(catalog, LOCALES)).toStrictEqual([{ line: 7, msgid: 'For "de": use German; for "fr": use French.' }]);
    });
});
