const SCRIPT_UNSAFE = /[<>/\u{2028}\u{2029}]/gu;

const SCRIPT_ESCAPES: Readonly<Record<string, string>> = {
    "/": String.raw`\u002f`,
    "<": String.raw`\u003c`,
    ">": String.raw`\u003e`,
    "\u{2028}": String.raw`\u2028`,
    "\u{2029}": String.raw`\u2029`,
};

/**
 * `value` as a JavaScript literal that is safe inside an inline `<script>`: JSON, with `<`, `>` and `/` escaped so it
 * can never close the element or open a comment, and U+2028 / U+2029 escaped for engines that treat them as line
 * breaks. Those characters only occur inside JSON strings, where the escapes decode to the same text.
 */
export const toScriptLiteral = (value: unknown): string =>
    JSON.stringify(value).replaceAll(SCRIPT_UNSAFE, (character: string) => SCRIPT_ESCAPES[character] ?? character);
