import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const localesDirectory = resolve(import.meta.dirname, "../src/locales");
const locales = readdirSync(localesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

// A hand or scripted translation once pasted a map of every locale's string,
// `{'de': '…', 'es': '…'}`, as each catalog's msgstr, and users saw the map.
const localeMap = new RegExp(`'(?:${locales.join("|")})': '`);

describe("locale catalogs", () => {
    it.each(locales)("%s holds no msgstr that is a map of translations", (locale) => {
        const catalog = readFileSync(join(localesDirectory, locale, "messages.po"), "utf8");
        const corrupted = catalog.split("\n").filter((line) => line.startsWith("msgstr ") && (line.startsWith("msgstr \"{'") || localeMap.test(line)));

        expect(corrupted).toStrictEqual([]);
    });
});
