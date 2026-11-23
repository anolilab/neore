#!/usr/bin/env node
// Run by `translate:compile` before `lingui compile`: refuses a catalog whose translation is a map of every
// locale's string (`./i18n/locale-map.mjs`), which would compile and show users the map.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import config from "../lingui.config.ts";
import { findLocaleMaps } from "./i18n/locale-map.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const found = [];

for (const locale of config.locales) {
    const path = join("src", "locales", locale, "messages.po");

    for (const { line, msgid } of findLocaleMaps(await readFile(join(appRoot, path), "utf8"), config.locales)) {
        found.push(`${path}:${String(line)}: the translation of "${msgid}" is a map of locales`);
    }
}

if (found.length > 0) {
    console.error(`${found.join("\n")}\nGive each catalog its own locale's string.`);
    process.exit(1);
}
