/**
 * Text the person approves must be text they can read. Control characters, format characters (bidi overrides, zero
 * width space, word joiner, byte order mark), the tag block (U+E0000 to U+E007F, which many renderers draw as nothing; most of it is `\p{Cf}`, the rest is spelled out), the line
 * and paragraph separators and stray variation selectors render as nothing or reorder what is around them, so none of them is allowed in a hooks
 * file's strings, and none reaches the agent in a path.
 *
 * Two kinds of character are hidden only OUT OF PLACE, because a run of either can carry an invisible payload (the
 * "variation-selector smuggling" and tag-character techniques) while a single one renders something:
 * - a variation selector stays only when it is the ONE selector directly after a base character it can really select
 *   a variant of (one selector after each letter would still smuggle a byte per letter): U+FE0E and U+FE0F after a
 *   character that can take emoji presentation (`Extended_Pictographic`, `Emoji_Presentation`; after a keycap base,
 *   0-9 # *, only when U+20E3 follows); U+E0100 to U+E01EF after an ideograph; U+FE00 to U+FE0D after an ideograph or a
 *   math or other symbol (`Sm`, `So`), never after a letter or digit;
 * - the joiners U+200C and U+200D stay only as the ONE joiner between two visible characters (a ZWJ emoji, a Persian
 *   word): a run of them, alternating, is a binary payload, and one at an end of the text or beside a hidden character
 *   renders nothing;
 * - the tag letters and CANCEL TAG of the three subdivision flags (England, Scotland, Wales: `gbeng`, `gbsct`, `gbwls`)
 *   stay when they directly follow U+1F3F4 and spell exactly one of those codes, then U+E007F; any other tag sequence is text.
 * The `strict` form treats every joiner and tag as hidden, and every selector but the one U+FE0E or U+FE0F directly after
 * an emoji base (a name or a prompt with a plain emoji, such as a warning sign, still loads; a run or a selector after a letter does not).
 */

// The format characters that RENDER stay (U+0600 to U+0605 Arabic number signs, U+06DD end of ayah, U+070F Syriac abbreviation
// mark, U+08E2, U+110BD, U+110CD). Variation selectors and the joiners U+200C and U+200D are matched here and kept by `scan`
// where they belong. Global expressions: `matchAll` clones them, so no state is shared between calls.
const HIDDEN =
    /(?![\u{600}-\u{605}\u{6DD}\u{70F}\u{8E2}\u{110BD}\u{110CD}])[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
// The strict form also counts the joiners, the visible format characters and every selector and tag: for text nobody wrote to be read in prose (a repository's names and globs).
// One hidden character, not global: no `lastIndex` to carry between calls.
const HIDDEN_ONE = new RegExp(HIDDEN.source, "u");
const HIDDEN_STRICT = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
// U+1F3F4 BLACK FLAG, the tags of one of the three RGI subdivision flags (England, Scotland, Wales: `gbeng`, `gbsct`, `gbwls`), CANCEL TAG.
// Any other code is free text in tag letters, so it is not allowed.
const SUBDIVISION_FLAG = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
const BLACK_FLAG_UNITS = 2;
// What each kind of selector can modify. Another selector, a mark, a space or a control is no base for any of them.
const EMOJI_BASE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u;
const KEYCAP_BASE = /^[0-9#*]$/u;
const IDEOGRAPH = /^\p{Ideographic}$/u;
const SYMBOL = /^[\p{Sm}\p{So}]$/u;
const COMBINING_ENCLOSING_KEYCAP = 0x20_e3;

type Range = { index: number; length: number };

const isTagCharacter = (codePoint: number): boolean => codePoint >= 0xe_00_00 && codePoint <= 0xe_00_7f;

const isVariationSelector = (codePoint: number): boolean =>
    (codePoint >= 0xfe_00 && codePoint <= 0xfe_0f) || (codePoint >= 0xe_01_00 && codePoint <= 0xe_01_ef);

/** The code point that ends just before `index` ("" at the start). */
const characterBefore = (value: string, index: number): string => {
    const pair = index > 1 ? (value.codePointAt(index - 2) ?? 0) : 0;

    return value.slice(pair > 0xff_ff ? index - 2 : Math.max(index - 1, 0), index);
};

const isJoiner = (codePoint: number): boolean => codePoint === 0x20_0c || codePoint === 0x20_0d;

const isEmojiSelector = (codePoint: number): boolean => codePoint === 0xfe_0e || codePoint === 0xfe_0f;

/** Whether the variation selector at `index` selects a variant of the character before it (see the top of the file). */
const selectorBelongs = (value: string, index: number, codePoint: number): boolean => {
    // A second selector in a run follows a selector, which is no base character for any of the tests below.
    const base = characterBefore(value, index);

    if (codePoint >= 0xe_01_00) {
        return IDEOGRAPH.test(base);
    }

    if (codePoint >= 0xfe_0e) {
        return EMOJI_BASE.test(base) || (KEYCAP_BASE.test(base) && value.codePointAt(index + 1) === COMBINING_ENCLOSING_KEYCAP);
    }

    return IDEOGRAPH.test(base) || SYMBOL.test(base);
};

/**
 * A joiner stays only as the ONE joiner between two visible characters (a ZWJ emoji, a Persian word). A run of them,
 * or a joiner beside a hidden character or at an end of the text, can carry a bit per character.
 */
const joinsVisibleCharacters = (value: string, index: number): boolean => {
    const before = characterBefore(value, index);
    const next = value.codePointAt(index + 1);

    if (before === "" || next === undefined || HIDDEN_ONE.test(String.fromCodePoint(next))) {
        return false;
    }

    if (!HIDDEN_ONE.test(before)) {
        return true;
    }

    // The one hidden character that may stand before a joiner is a selector that belongs to its base (heart, VS16, ZWJ, fire).
    const beforeCode = before.codePointAt(0) ?? 0;

    return isVariationSelector(beforeCode) && selectorBelongs(value, index - before.length, beforeCode);
};

/** Whether the hidden-looking character at `index` belongs where it stands (see the top of the file). */
const belongsInPlace = (value: string, index: number, codePoint: number, inFlag: (index: number) => boolean): boolean => {
    if (isTagCharacter(codePoint)) {
        return inFlag(index);
    }

    if (isJoiner(codePoint)) {
        return joinsVisibleCharacters(value, index);
    }

    return isVariationSelector(codePoint) && selectorBelongs(value, index, codePoint);
};

/**
 * Whether an index lies in one of the ordered, disjoint `ranges`. The indexes asked about arrive in order, so a cursor
 * that only moves forward answers all of them in linear time.
 */
const rangeCursor = (ranges: ReadonlyArray<readonly [number, number]>): ((index: number) => boolean) => {
    let at = 0;

    return (index) => {
        while (at < ranges.length && (ranges[at]?.[1] ?? 0) <= index) {
            at += 1;
        }

        const range = ranges[at];

        return range !== undefined && index >= range[0];
    };
};

/**
 * Every hidden character in `value`, in order. `layout`: a newline and a tab are not hidden. The selectors and tags
 * that belong where they stand are left out, unless `strict`.
 */
const scan = (value: string, { layout = false, strict = false }: { layout?: boolean; strict?: boolean } = {}): Range[] => {
    // The tag characters of each well-formed subdivision flag: from after the black flag to the end of the cancel tag.
    const inFlag = rangeCursor(
        strict ? [] : Array.from(value.matchAll(SUBDIVISION_FLAG), (match) => [match.index + BLACK_FLAG_UNITS, match.index + match[0].length] as const),
    );
    const ranges: Range[] = [];

    const matches = value.matchAll(strict ? HIDDEN_STRICT : HIDDEN);

    for (const match of matches) {
        const { index } = match;
        const character = match[0];

        if (layout && (character === "\n" || character === "\t")) {
            continue;
        }

        const codePoint = character.codePointAt(0) ?? 0;

        if (strict ? isEmojiSelector(codePoint) && selectorBelongs(value, index, codePoint) : belongsInPlace(value, index, codePoint, inFlag)) {
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
 * lines); a carriage return does not, so `\r\n` arrives as `\n`. A joiner (U+200D, U+200C) stays only alone between two visible
 * characters, where emoji sequences and Persian, Arabic and Indic text need it to render. A variation selector stays only as the one directly after a
 * character it can select a variant of (see the top of the file), and a tag only as the tail of a subdivision flag.
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
