// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const LOCALES_DIR = resolve(import.meta.dirname, "../../../locales");
const MSGID = String.raw`msgid "Search failed for \"{searchQuery}\". Try again."`;
const MSGSTR = /^msgstr "(.*)"$/u;

/** The translation of the search-failure message in one locale's catalog. */
const translationIn = (locale: string): string | undefined => {
    const lines = readFileSync(resolve(LOCALES_DIR, locale, "messages.po"), "utf8").split("\n");
    const at = lines.indexOf(MSGID);

    return at === -1 ? undefined : MSGSTR.exec(lines[at + 1] ?? "")?.[1];
};

describe("the sidebar's search-failure message", () => {
    it.each(
        readdirSync(LOCALES_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
    )("is translated in %s, with the query kept", (locale: string) => {
        const translation = translationIn(locale);

        expect(translation).toBeTruthy();
        expect(translation).toContain("{searchQuery}");
    });
});
