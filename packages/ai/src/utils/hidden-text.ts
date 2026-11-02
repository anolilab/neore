/**
 * Text the person approves must be text they can read. Control characters, format characters (bidi overrides, zero
 * width space, word joiner, byte order mark), the tag block (U+E0000 to U+E007F, which many renderers draw as nothing; most of it is `\p{Cf}`, the rest is spelled out), the line
 * and paragraph separators and stray variation selectors render as nothing or reorder what is around them, so none of them is allowed (U+200C and U+200D excepted: see `stripHiddenText`) in a hooks
 * file's strings, and none reaches the agent in a path.
 *
 * Two kinds of character are hidden only OUT OF PLACE, because a run of either can carry an invisible payload (the
 * "variation-selector smuggling" and tag-character techniques) while a single one renders something:
 * - a variation selector (U+FE00 to U+FE0F, U+E0100 to U+E01EF) stays when it is the ONE selector directly after a
 *   visible base character (VS15/VS16 after an emoji, an ideographic selector after a CJK ideograph);
 * - the tag letters, digits and CANCEL TAG of a subdivision flag (England, Scotland, Wales) stay when they directly
 *   follow U+1F3F4 and are well formed: 1 to 6 tag characters, then U+E007F.
 * The `strict` form treats every selector and tag as hidden.
 */

// The format characters that RENDER stay (U+0600 to U+0605 Arabic number signs, U+06DD end of ayah, U+070F Syriac abbreviation
// mark, U+08E2, U+110BD, U+110CD), with the joiners U+200C and U+200D: prose needs them. Variation selectors are matched
// here and kept by `scan` where they belong. Global expressions: `matchAll` clones them, so no state is shared between calls.
const HIDDEN =
    /(?![\u{600}-\u{605}\u{6DD}\u{70F}\u{8E2}\u{110BD}\u{110CD}\u{200C}\u{200D}])[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
// The strict form also counts the joiners, the visible format characters and every selector and tag: for text nobody wrote to be read in prose (a repository's names and globs).
const HIDDEN_STRICT = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
// U+1F3F4 BLACK FLAG, 1 to 6 tag digits or letters (a subdivision code such as `gbeng`), CANCEL TAG.
const SUBDIVISION_FLAG = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}/gu;
const BLACK_FLAG_UNITS = 2;
// Something a selector can modify: a letter, number, punctuation mark or symbol (emoji are symbols). Not another selector, a mark, a space or a control.
const BASE_CHARACTER = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

type Range = { index: number; length: number };

const isTagCharacter = (codePoint: number): boolean => codePoint >= 0xe_00_00 && codePoint <= 0xe_00_7f;

const isVariationSelector = (codePoint: number): boolean =>
    (codePoint >= 0xfe_00 && codePoint <= 0xfe_0f) || (codePoint >= 0xe_01_00 && codePoint <= 0xe_01_ef);

/** The code point that ends just before `index` ("" at the start). */
const characterBefore = (value: string, index: number): string => {
    const pair = index > 1 ? (value.codePointAt(index - 2) ?? 0) : 0;

    return value.slice(pair > 0xff_ff ? index - 2 : Math.max(index - 1, 0), index);
};

/** Whether the hidden-looking character at `index` belongs where it stands (see the top of the file). */
const belongsInPlace = (value: string, index: number, codePoint: number, flagTags: ReadonlyArray<readonly [number, number]>): boolean => {
    if (isTagCharacter(codePoint)) {
        return flagTags.some(([from, to]) => index >= from && index < to);
    }

    // A second selector in a run follows a selector, which is no base character.
    return isVariationSelector(codePoint) && BASE_CHARACTER.test(characterBefore(value, index));
};

/**
 * Every hidden character in `value`, in order. `layout`: a newline and a tab are not hidden. The selectors and tags
 * that belong where they stand are left out, unless `strict`.
 */
const scan = (value: string, { layout = false, strict = false }: { layout?: boolean; strict?: boolean } = {}): Range[] => {
    // The tag characters of each well-formed subdivision flag: from after the black flag to the end of the cancel tag.
    const flagTags = strict
        ? []
        : Array.from(value.matchAll(SUBDIVISION_FLAG), (match) => [match.index + BLACK_FLAG_UNITS, match.index + match[0].length] as const);
    const ranges: Range[] = [];

    const matches = value.matchAll(strict ? HIDDEN_STRICT : HIDDEN);

    for (const match of matches) {
        const { index } = match;
        const character = match[0];

        if (layout && (character === "\n" || character === "\t")) {
            continue;
        }

        if (!strict && belongsInPlace(value, index, character.codePointAt(0) ?? 0, flagTags)) {
            continue;
        }

        ranges.push({ index, length: character.length });
    }

    return ranges;
};

/**
 * `layout`: a newline and a tab are plain layout, so a multi-line prompt can have them. `strict`: the joiners U+200C
 * and U+200D count as hidden too (prompts allow them for emoji and Persian; a name or glob has no use for them), and so
 * does every variation selector and tag character.
 */
export const hasHiddenText = (value: string, options: { layout?: boolean; strict?: boolean } = {}): boolean => scan(value, options).length > 0;

/** The text with every hidden character shown as `?`; `strict` marks the joiners too. */
export const showHidden = (value: string, options: { strict?: boolean } = {}): string => {
    let shown = "";
    let from = 0;

    for (const { index, length } of scan(value, options)) {
        shown += `${value.slice(from, index)}?`;
        from = index + length;
    }

    return shown + value.slice(from);
};

/**
 * The text with every hidden character removed, and how many there were. A newline and a tab stay (a prompt has
 * lines); a carriage return does not, so `\r\n` arrives as `\n`. U+200D and U+200C stay: emoji sequences and
 * Persian, Arabic and Indic text need them to render. A variation selector stays only as the one directly after a
 * base character, and a tag only as the tail of a subdivision flag.
 */
export const stripHiddenText = (value: string): { removed: number; text: string } => {
    const ranges = scan(value, { layout: true });
    let text = "";
    let from = 0;

    for (const { index, length } of ranges) {
        text += value.slice(from, index);
        from = index + length;
    }

    return { removed: ranges.length, text: text + value.slice(from) };
};

/** Where each hidden character sits in `value` (UTF-16 offset and length, a tag character is 2 units), in order. */
export const findHiddenText = (value: string): { index: number; length: number }[] => scan(value, { layout: true });
