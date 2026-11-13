/**
 * Reading an inline `style` attribute as CSS does, for the paste preset: which value a property ends up with.
 */

// How a character changes the depth of parentheses a style's reader is in.
const DEPTH_CHANGE: Readonly<Record<string, number>> = { "(": 1, ")": -1 };
const QUOTES = new Set(["'", `"`]);

/**
 * The value an inline style gives a property, as CSS reads it: the last declaration wins, unless an earlier one is
 * `!important` and the later one is not. Lower case, without `!important`; empty when the style sets none.
 */
export function declaredStyle(
    style: string,
    property: string | ReadonlyArray<string>,
    isValid: (value: string, property: string) => boolean = () => true,
): string {
    // Several properties when they set the same thing, such as a shorthand and its longhand: the last of any of them wins.
    const properties: ReadonlyArray<string> = typeof property === "string" ? [property] : property;
    let value = "";
    let isImportant = false;

    const parts = declarations(style);

    for (const declaration of parts) {
        const colon = declaration.indexOf(":");

        const name = colon === -1 ? "" : declaration.slice(0, colon).trim().toLowerCase();

        if (!properties.includes(name)) {
            continue;
        }

        const raw = declaration.slice(colon + 1);
        const { isImportant: isThisImportant, value: candidate } = priority(raw);

        // A browser drops a declaration whose value it cannot read, so an invalid value overrides nothing.
        if ((isThisImportant || !isImportant) && isValid(candidate, name)) {
            value = candidate;
            isImportant = isThisImportant;
        }
    }

    return value;
}

/**
 * The declarations of an inline style, without its comments: split at each `;` that is not inside a quoted string or
 * parentheses, so a value such as `url('a;b')` or `"x; y"` stays whole.
 */
function declarations(style: string): string[] {
    const parts: string[] = [];
    let current = "";
    let depth = 0;
    let index = 0;

    while (index < style.length) {
        const char = style.charAt(index);

        if (QUOTES.has(char)) {
            const end = afterQuoted(style, index);

            current += style.slice(index, end);
            index = end;
            continue;
        }

        // A comment is no text to CSS (a value broken by one reads as if it were not there); an unclosed one runs to the
        // end. Markers inside a quoted string are its text, so they were copied above.
        if (style.startsWith("/*", index)) {
            const close = style.indexOf("*/", index + 2);

            index = close === -1 ? style.length : close + 2;
            // A comment ends the word before it: `no/**/ne` is two words to CSS, not `none`.
            current += " ";
            continue;
        }

        depth = Math.max(0, depth + (DEPTH_CHANGE[char] ?? 0));

        if (char === ";" && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += char;
        }

        index += 1;
    }

    parts.push(current);

    return parts;
}

/** The index after the quoted string that opens at `open`, skipping a backslash and the character after it. */
function afterQuoted(style: string, open: number): number {
    const quote = style.charAt(open);
    let index = open + 1;

    while (index < style.length) {
        const char = style.charAt(index);

        if (char === quote) {
            return index + 1;
        }

        index += char === "\\" ? 2 : 1;
    }

    return style.length;
}

/** A declaration's value and whether it is `!important`; any whitespace may come before and after the `!`. */
function priority(raw: string): { isImportant: boolean; value: string } {
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();

    if (lower.endsWith("important")) {
        const before = trimmed.slice(0, -"important".length).trimEnd();

        if (before.endsWith("!")) {
            return { isImportant: true, value: before.slice(0, -1).trim().toLowerCase() };
        }
    }

    return { isImportant: false, value: lower };
}
