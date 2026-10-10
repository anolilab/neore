// Minimal reader and in-place patcher for the `.po` catalogs `@lingui/format-po`
// writes. Patching rewrites ONLY the `msgstr` lines of the entries it
// translates and leaves every other byte alone, so a run's diff is exactly its
// translations — `lingui extract` owns the file's layout, not this script.

const unescape = (value) =>
    value.replaceAll(/\\(.)/gu, (_, char) => {
        switch (char) {
            case "n": {
                return "\n";
            }
            case "r": {
                return "\r";
            }
            case "t": {
                return "\t";
            }
            default: {
                return char;
            }
        }
    });

export const escapePoString = (value) =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");

const readQuoted = (line) => {
    const match = /"(.*)"\s*$/u.exec(line);

    return match ? unescape(match[1]) : "";
};

/**
 * @typedef {object} PoEntry
 * @property {string} key msgctxt + EOT + msgid, or msgid alone.
 * @property {string | undefined} msgctxt
 * @property {string} msgid
 * @property {string} msgstr
 * @property {string[]} extracted `#.` comments — lingui puts placeholder origins here.
 * @property {string[]} references `#:` source locations.
 * @property {string[]} flags `#,` flags.
 * @property {boolean} plural carries `msgid_plural`; lingui never emits it, so it is skipped.
 * @property {[number, number]} msgstrLines inclusive line range of the msgstr field.
 */

export const entryKey = (msgctxt, msgid) => (msgctxt === undefined ? msgid : `${msgctxt}\u0004${msgid}`);

/**
 * Parses the active entries of a catalog. The header (`msgid ""`) and obsolete
 * `#~` entries are not returned.
 *
 * @param {string} text
 * @returns {PoEntry[]}
 */
export const parsePo = (text) => {
    const lines = text.split("\n");
    const entries = [];
    let current;
    let field;

    const flush = () => {
        if (current?.msgid !== undefined && current.msgid !== "" && current.msgstrLines) {
            current.key = entryKey(current.msgctxt, current.msgid);
            entries.push(current);
        }

        current = undefined;
        field = undefined;
    };

    const ensure = () => {
        current ??= { extracted: [], flags: [], plural: false, references: [] };

        return current;
    };

    for (const [index, line] of lines.entries()) {
        if (line.trim() === "") {
            flush();
            continue;
        }

        if (line.startsWith("#~")) {
            // Obsolete entry; drop whatever was being collected for it.
            current = { extracted: [], flags: [], obsolete: true, plural: false, references: [] };
            field = undefined;
            continue;
        }

        const entry = ensure();

        if (entry.obsolete) {
            continue;
        }

        if (line.startsWith("#.")) {
            entry.extracted.push(line.slice(2).trim());
        } else if (line.startsWith("#:")) {
            entry.references.push(...line.slice(2).trim().split(/\s+/u));
        } else if (line.startsWith("#,")) {
            entry.flags.push(
                ...line
                    .slice(2)
                    .split(",")
                    .map((flag) => flag.trim())
                    .filter(Boolean),
            );
        } else if (line.startsWith("#")) {
            // Translator or previous-msgid comment; not needed.
        } else if (line.startsWith("msgctxt ")) {
            entry.msgctxt = readQuoted(line);
            field = "msgctxt";
        } else if (line.startsWith("msgid_plural ")) {
            entry.plural = true;
            field = undefined;
        } else if (line.startsWith("msgid ")) {
            entry.msgid = readQuoted(line);
            field = "msgid";
        } else if (line.startsWith("msgstr[")) {
            entry.plural = true;
            field = undefined;
        } else if (line.startsWith("msgstr ")) {
            entry.msgstr = readQuoted(line);
            entry.msgstrLines = [index, index];
            field = "msgstr";
        } else if (line.startsWith('"') && field) {
            entry[field] += readQuoted(line);

            if (field === "msgstr") {
                entry.msgstrLines[1] = index;
            }
        }
    }

    flush();

    return entries.filter((entry) => !entry.obsolete);
};

/**
 * Replaces the msgstr of each entry in `translations` (keyed by entry key).
 * Keys not present in the catalog are ignored.
 *
 * @param {string} text
 * @param {Map<string, string>} translations
 * @returns {string}
 */
export const patchPo = (text, translations) => {
    const lines = text.split("\n");
    const targets = parsePo(text)
        .filter((entry) => translations.has(entry.key))
        .toSorted((a, b) => b.msgstrLines[0] - a.msgstrLines[0]);

    for (const entry of targets) {
        const [start, end] = entry.msgstrLines;

        lines.splice(start, end - start + 1, `msgstr "${escapePoString(translations.get(entry.key))}"`);
    }

    return lines.join("\n");
};
