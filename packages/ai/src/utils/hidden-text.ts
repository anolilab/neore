/**
 * Text the person approves must be text they can read. Control characters, format characters (bidi overrides, zero
 * width space, word joiner, byte order mark), the tag block (U+E0000 to U+E007F, which many renderers draw as nothing; most of it is `\p{Cf}`, the rest is spelled out) and the line
 * and paragraph separators render as nothing or reorder what is around them, so none of them is allowed (U+200C and U+200D excepted: see `stripHiddenText`) in a hooks
 * file's strings, and none reaches the agent in a path.
 */

// Two expressions: a global one keeps state between `.test` calls, so the check and the replacement do not share one.
// Format characters that RENDER stay (U+0600 to U+0605 Arabic number signs, U+06DD end of ayah, U+070F Syriac abbreviation
// mark, U+08E2, U+110BD, U+110CD), with the joiners U+200C and U+200D: prose needs them.
const HIDDEN = /(?![\u{600}-\u{605}\u{6DD}\u{70F}\u{8E2}\u{110BD}\u{110CD}\u{200C}\u{200D}])[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/u;
const HIDDEN_EVERYWHERE =
    /(?![\u{600}-\u{605}\u{6DD}\u{70F}\u{8E2}\u{110BD}\u{110CD}\u{200C}\u{200D}])[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
// The strict forms also count the joiners and the visible format characters: for text nobody wrote to be read in prose (a repository's names and globs).
const HIDDEN_STRICT = /[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/u;
const HIDDEN_STRICT_EVERYWHERE = /[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
const HIDDEN_EXCEPT_LAYOUT =
    /(?![\n\t\u{600}-\u{605}\u{6DD}\u{70F}\u{8E2}\u{110BD}\u{110CD}\u{200C}\u{200D}])[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
const LAYOUT = /[\n\t]/gu;

/**
 * `layout`: a newline and a tab are plain layout, so a multi-line prompt can have them. `strict`: the joiners U+200C
 * and U+200D count as hidden too (prompts allow them for emoji and Persian; a name or glob has no use for them).
 */
export const hasHiddenText = (value: string, options: { layout?: boolean; strict?: boolean } = {}): boolean =>
    (options.strict === true ? HIDDEN_STRICT : HIDDEN).test(options.layout === true ? value.replaceAll(LAYOUT, "") : value);

/** The text with every hidden character shown as `?`; `strict` marks the joiners too. */
export const showHidden = (value: string, options: { strict?: boolean } = {}): string =>
    value.replaceAll(options.strict === true ? HIDDEN_STRICT_EVERYWHERE : HIDDEN_EVERYWHERE, "?");

/**
 * The text with every hidden character removed, and how many there were. A newline and a tab stay (a prompt has
 * lines); a carriage return does not, so `\r\n` arrives as `\n`. U+200D and U+200C stay: emoji sequences and
 * Persian, Arabic and Indic text need them to render. Variation selectors are not format characters and stay too.
 */
export const stripHiddenText = (value: string): { removed: number; text: string } => {
    let removed = 0;
    const text = value.replaceAll(HIDDEN_EXCEPT_LAYOUT, () => {
        removed += 1;

        return "";
    });

    return { removed, text };
};

/** Where each hidden character sits in `value` (UTF-16 offset and length, a tag character is 2 units), in order. */
export const findHiddenText = (value: string): { index: number; length: number }[] =>
    // Array.from, not the iterator helpers (`.map().toArray()`): Safari < 18.4, Chrome < 122 and Firefox < 131 lack them.
    Array.from(value.matchAll(HIDDEN_EXCEPT_LAYOUT), (match) => {
        return { index: match.index, length: match[0].length };
    });
