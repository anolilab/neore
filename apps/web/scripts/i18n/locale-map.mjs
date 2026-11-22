// A translation pasted as a map of every locale's string (`{'de': '…', 'es': '…'}`) instead of one locale's: it
// compiles, and users see the map. `translate:compile` refuses a catalog holding one, and a model reply is rejected.

import { parsePo } from "./po.mjs";

const escapeRegExp = (value) => value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

/**
 * Whether `text` reads as a map keyed by locale: two or more locales as quoted keys, or one opening it.
 *
 * @param {string} text
 * @param {readonly string[]} locales
 * @returns {boolean}
 */
export const looksLikeLocaleMap = (text, locales) => {
    const key = new RegExp(`(['"])(${locales.map(escapeRegExp).join("|")})\\1\\s*:`, "gu");
    const keys = new Set([...text.matchAll(key)].map((match) => match[2]));

    return keys.size >= 2 || (keys.size === 1 && new RegExp(`^\\{\\s*${key.source}`, "u").test(text.trim()));
};

/**
 * The entries of a catalog whose translation, continuation lines joined, is such a map, and whose source is not: a
 * faithful translation of a source that itself reads as one is left, as the batch check leaves it.
 *
 * @param {string} catalog a `.po` file's text
 * @param {readonly string[]} locales
 * @returns {{ line: number, msgid: string }[]}
 */
export const findLocaleMaps = (catalog, locales) =>
    parsePo(catalog)
        .filter((entry) => looksLikeLocaleMap(entry.msgstr, locales) && !looksLikeLocaleMap(entry.msgid, locales))
        .map((entry) => {
            return { line: entry.msgstrLines[0] + 1, msgid: entry.msgid };
        });
