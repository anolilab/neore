// ICU MessageFormat checks for machine translations.
//
// Lingui compiles a message with `@messageformat/parser` and, if that throws,
// logs the error and renders the RAW string — so a broken translation ships as
// visible `{0, plural, ...}` text, not as a build failure. Everything an LLM
// can get wrong therefore has to be caught here, before it lands in a catalog.
//
// This is a small recursive-descent parser for the subset lingui emits, plus
// lingui's numbered JSX tags (`<0>…</0>`, `<0/>`). It follows ICU's
// DOUBLE_OPTIONAL apostrophe mode, the one `@messageformat/parser` uses: `''`
// is a literal apostrophe, and a single `'` directly before `{`, `}` or (inside
// a plural) `#` starts quoted literal text. That matters for fr/it, where
// `l'{0}` silently turns the placeholder into the literal text "{0}".
//
// It is deliberately STRICTER than `@messageformat/parser`, which accepts a
// stray `}`, unknown formatter names, duplicate or missing `other` cases, and
// reads `{{name}}` as "{" + argument + "}". Each of those renders wrong at
// runtime without an error, so a source that trips one is skipped (and logged)
// rather than propagated into eight languages. Cross-checked against the real
// parser over every en/de catalog string: those are the only disagreements.

const PLURAL_TYPES = new Set(["plural", "selectordinal"]);
const FORMAT_TYPES = new Set(["date", "number", "time"]);
const PLURAL_KEY = /^(?:zero|one|two|few|many|other|=\d+)$/;
const TAG = /^<(\/?)(\d+)(\/?)>/;

export class IcuSyntaxError extends Error {
    constructor(message, position) {
        super(`${message} (at offset ${position})`);
        this.name = "IcuSyntaxError";
    }
}

/**
 * @typedef {object} MessageSignature
 * @property {Set<string>} placeholders `name:type` for every argument, at any depth.
 * @property {Set<string>} tags `<0>`, `</0>`, `<0/>` for every numbered tag.
 * @property {Map<string, string[]>} selectKeys sorted option keys of every `select`.
 */

/**
 * Parses `message` and returns what a translation of it must preserve.
 *
 * @param {string} message
 * @returns {MessageSignature}
 * @throws {IcuSyntaxError}
 */
export const parseMessage = (message) => {
    const signature = { placeholders: new Set(), selectKeys: new Map(), tags: new Set() };
    let pos = 0;

    const skipWhitespace = () => {
        while (pos < message.length && /\s/u.test(message[pos])) {
            pos += 1;
        }
    };

    const readWord = () => {
        const start = pos;

        while (pos < message.length && !/[\s,{}]/u.test(message[pos])) {
            pos += 1;
        }

        return message.slice(start, pos);
    };

    // Consumes a quoted literal starting at the opening apostrophe. An
    // unterminated quote runs to the end of the message, as in ICU.
    const skipQuoted = () => {
        pos += 1;

        while (pos < message.length) {
            if (message[pos] === "'") {
                if (message[pos + 1] === "'") {
                    pos += 2;
                    continue;
                }

                pos += 1;

                return;
            }

            pos += 1;
        }
    };

    const parseArgument = (inPlural) => {
        const open = pos;

        pos += 1;
        skipWhitespace();

        const name = readWord();

        if (name === "") {
            throw new IcuSyntaxError("empty argument name", open);
        }

        skipWhitespace();

        if (message[pos] === "}") {
            pos += 1;
            signature.placeholders.add(`${name}:arg`);

            return;
        }

        if (message[pos] !== ",") {
            throw new IcuSyntaxError(`expected "," or "}" after argument "${name}"`, pos);
        }

        pos += 1;
        skipWhitespace();

        const type = readWord();

        skipWhitespace();

        if (FORMAT_TYPES.has(type)) {
            signature.placeholders.add(`${name}:${type}`);

            if (message[pos] === "}") {
                pos += 1;

                return;
            }

            if (message[pos] !== ",") {
                throw new IcuSyntaxError(`expected "," or "}" after "${type}"`, pos);
            }

            // Style or `::skeleton` — opaque, but must not contain braces.
            const end = message.indexOf("}", pos);

            if (end === -1 || message.slice(pos, end).includes("{")) {
                throw new IcuSyntaxError(`unterminated ${type} style`, pos);
            }

            pos = end + 1;

            return;
        }

        if (type !== "select" && !PLURAL_TYPES.has(type)) {
            throw new IcuSyntaxError(`unknown argument type "${type}"`, pos);
        }

        signature.placeholders.add(`${name}:${type}`);

        if (message[pos] !== ",") {
            throw new IcuSyntaxError(`expected "," after "${type}"`, pos);
        }

        pos += 1;
        skipWhitespace();

        const isPlural = PLURAL_TYPES.has(type);

        if (isPlural && message.startsWith("offset:", pos)) {
            pos += "offset:".length;

            const offset = readWord();

            if (!/^\d+$/u.test(offset)) {
                throw new IcuSyntaxError(`invalid plural offset "${offset}"`, pos);
            }

            skipWhitespace();
        }

        const keys = [];

        while (message[pos] !== "}") {
            if (pos >= message.length) {
                throw new IcuSyntaxError(`unterminated ${type} for "${name}"`, open);
            }

            const key = readWord();

            if (key === "") {
                throw new IcuSyntaxError(`expected a ${type} key`, pos);
            }

            if (isPlural && !PLURAL_KEY.test(key)) {
                throw new IcuSyntaxError(`invalid ${type} key "${key}"`, pos);
            }

            if (keys.includes(key)) {
                throw new IcuSyntaxError(`duplicate ${type} key "${key}"`, pos);
            }

            keys.push(key);
            skipWhitespace();

            if (message[pos] !== "{") {
                throw new IcuSyntaxError(`expected "{" after ${type} key "${key}"`, pos);
            }

            pos += 1;
            // eslint-disable-next-line no-use-before-define -- mutual recursion
            parseBody(true, isPlural || inPlural);
            pos += 1;
            skipWhitespace();
        }

        if (!keys.includes("other")) {
            throw new IcuSyntaxError(`${type} for "${name}" has no "other" case`, open);
        }

        pos += 1;

        if (type === "select") {
            signature.selectKeys.set(name, keys.toSorted());
        }
    };

    // Parses literal text until the closing `}` of a nested message (left
    // unconsumed) or the end of input. Tags must balance within one body.
    const parseBody = (nested, inPlural) => {
        const openTags = [];

        while (pos < message.length) {
            const char = message[pos];

            if (char === "'") {
                const next = message[pos + 1];

                if (next === "'") {
                    pos += 2;
                } else if (next === "{" || next === "}" || (inPlural && next === "#")) {
                    skipQuoted();
                } else {
                    pos += 1;
                }
            } else if (char === "{") {
                parseArgument(inPlural);
            } else if (char === "}") {
                if (!nested) {
                    throw new IcuSyntaxError('unmatched "}"', pos);
                }

                break;
            } else if (char === "<" && TAG.test(message.slice(pos))) {
                const [token, closing, index, selfClosing] = TAG.exec(message.slice(pos));

                if (closing && selfClosing) {
                    throw new IcuSyntaxError(`malformed tag "${token}"`, pos);
                }

                if (closing) {
                    if (openTags.pop() !== index) {
                        throw new IcuSyntaxError(`unexpected closing tag "${token}"`, pos);
                    }

                    signature.tags.add(`</${index}>`);
                } else if (selfClosing) {
                    signature.tags.add(`<${index}/>`);
                } else {
                    openTags.push(index);
                    signature.tags.add(`<${index}>`);
                }

                pos += token.length;
            } else {
                pos += 1;
            }
        }

        if (nested && pos >= message.length) {
            throw new IcuSyntaxError('missing closing "}"', pos);
        }

        if (openTags.length > 0) {
            throw new IcuSyntaxError(`unclosed tag "<${openTags.at(-1)}>"`, pos);
        }
    };

    parseBody(false, false);

    return signature;
};

const difference = (a, b) => [...a].filter((value) => !b.has(value));

const describe = (placeholder) => {
    const [name, type] = placeholder.split(":");

    return type === "arg" ? `{${name}}` : `{${name}, ${type}}`;
};

/**
 * Checks that `translation` is valid ICU and carries exactly the source's
 * placeholders, tags and select keys. Plural keys may differ — Polish needs
 * `few`/`many`, Japanese only `other` — so only `other` is required there.
 *
 * @param {string} source
 * @param {string} translation
 * @returns {string[]} problems; empty when the translation is acceptable.
 */
export const validateTranslation = (source, translation) => {
    if (typeof translation !== "string" || translation.trim() === "") {
        return ["translation is empty"];
    }

    const expected = parseMessage(source);
    let actual;

    try {
        actual = parseMessage(translation);
    } catch (error) {
        return [`invalid ICU syntax: ${error.message}`];
    }

    const problems = [];

    for (const missing of difference(expected.placeholders, actual.placeholders)) {
        problems.push(`missing placeholder ${describe(missing)}`);
    }

    for (const extra of difference(actual.placeholders, expected.placeholders)) {
        problems.push(`unexpected placeholder ${describe(extra)}`);
    }

    for (const missing of difference(expected.tags, actual.tags)) {
        problems.push(`missing tag ${missing}`);
    }

    for (const extra of difference(actual.tags, expected.tags)) {
        problems.push(`unexpected tag ${extra}`);
    }

    for (const [name, keys] of expected.selectKeys) {
        const actualKeys = actual.selectKeys.get(name);

        if (actualKeys && actualKeys.join("|") !== keys.join("|")) {
            problems.push(`select "${name}" must keep keys ${keys.join(", ")} (got ${actualKeys.join(", ")})`);
        }
    }

    return problems;
};
