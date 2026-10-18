/**
 * JSON checks and formatting for a workflow prompt written as JSON. Pure: never throws. The
 * text is only parsed and re-stringified here, never evaluated, and what a run sends is the
 * node's text as typed.
 */

/** Longer prompts are not parsed at all, so the check cannot be used to stall the editor. */
export const MAX_JSON_CHECK_CHARS = 100_000;

export type JsonCheck =
    | { status: "empty" }
    | { column: number | null; line: number | null; status: "invalid" }
    | { status: "too-long" }
    /** `formatChangesValues`: pretty-printing would not reproduce the text's values, so Format is refused. */
    | { formatChangesValues: boolean; status: "valid" };

export type JsonFormat = { check: JsonCheck; ok: false } | { ok: true; text: string };

type Parsed = { check: JsonCheck; ok: false } | { ok: true; value: unknown };

// Firefox ("at line 1 column 5 of the JSON data") and newer V8 ("(line 1 column 5)") name the line
// and column; older V8 names only an offset ("at position 4"). Safari names neither.
const LINE_COLUMN = /line (\d+) column (\d+)/;
const OFFSET = /at position (\d+)/;

// A string literal (kept whole, so its inner whitespace survives) or a run of whitespace (dropped).
const STRING_OR_WHITESPACE = /"(?:[^"\\]|\\[\s\S])*"|\s+/g;

/**
 * The 1-based line and column a JSON.parse error message points at, or null when it names neither.
 * Columns count UTF-16 code units, not characters: an emoji before the error counts as two.
 */
export const errorPosition = (text: string, message: string): { column: number; line: number } | null => {
    const lineColumn = LINE_COLUMN.exec(message);

    if (lineColumn) {
        return { column: Number(lineColumn[2]), line: Number(lineColumn[1]) };
    }

    const offset = OFFSET.exec(message);

    if (!offset) {
        return null;
    }

    const before = text.slice(0, Number(offset[1]));

    return { column: before.length - before.lastIndexOf("\n"), line: before.split("\n").length };
};

const parse = (text: string): Parsed => {
    if (text.length > MAX_JSON_CHECK_CHARS) {
        return { check: { status: "too-long" }, ok: false };
    }

    if (text.trim() === "") {
        return { check: { status: "empty" }, ok: false };
    }

    try {
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
        const position = errorPosition(text, error instanceof Error ? error.message : "");

        return { check: { column: position?.column ?? null, line: position?.line ?? null, status: "invalid" }, ok: false };
    }
};

/**
 * Format re-serialises the parsed value, so it is refused unless that reproduces the text token for
 * token. It would not for a number past double precision, a duplicate key (the last wins), a key
 * that integer-like keys reorder, or a string escape JSON.stringify writes differently (a unicode
 * escape for an at-sign, which the stringified text spells as a live mention). It also refuses a
 * harmless `1.0` written as `1`: a false positive, kept because the check is one comparison and
 * never wrongly allows a change.
 */
const changesValues = (text: string, value: unknown): boolean =>
    text.replaceAll(STRING_OR_WHITESPACE, (match) => (match.startsWith('"') ? match : "")) !== JSON.stringify(value);

export const checkJson = (text: string): JsonCheck => {
    const parsed = parse(text);

    return parsed.ok ? { formatChangesValues: changesValues(text, parsed.value), status: "valid" } : parsed.check;
};

/** Pretty-prints valid JSON with two-space indentation, or refuses when that would change a value (see `changesValues`). */
export const formatJson = (text: string): JsonFormat => {
    const parsed = parse(text);

    if (!parsed.ok) {
        return { check: parsed.check, ok: false };
    }

    if (changesValues(text, parsed.value)) {
        return { check: { formatChangesValues: true, status: "valid" }, ok: false };
    }

    return { ok: true, text: JSON.stringify(parsed.value, null, 2) };
};

// A string literal (kept whole), or a bare `{{variable}}` or `@mention` outside one (read as null). Strings come first, so a token inside quotes is never touched.
const STRING_OR_BARE_TOKEN = /"(?:[^"\\]|\\[\s\S])*"|\{\{[^{}]*\}\}|@[^\s"',:[\]{}]+/g;

/**
 * Whether an invalid template is invalid only because of a placeholder or mention outside quotes:
 * with each one read as `null`, the value a run may splice in, the text parses. Any other error (a
 * stray comma, a missing bracket) is not explained by a token, so this is false for it.
 */
export const isBareTokenCause = (text: string): boolean => {
    const withNulls = text.replaceAll(STRING_OR_BARE_TOKEN, (match) => (match.startsWith('"') ? match : "null"));

    return withNulls !== text && parse(withNulls).ok;
};
