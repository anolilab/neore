/**
 * Text the person approves must be text they can read. Control characters, format characters (bidi overrides, zero
 * width and joiner characters), the tag block (U+E0000 to U+E007F, which many renderers draw as nothing; most of it is `\p{Cf}`, the rest is spelled out) and the line
 * and paragraph separators render as nothing or reorder what is around them, so none of them is allowed in a hooks
 * file's strings, and none reaches the agent in a path.
 */

// Two expressions: a global one keeps state between `.test` calls, so the check and the replacement do not share one.
const HIDDEN = /[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/u;
const HIDDEN_EVERYWHERE = /[\p{Cc}\p{Cf}\u{E0000}\u{E0002}-\u{E001F}\u{2028}\u{2029}]/gu;
const LAYOUT = /[\n\t]/gu;

/** `layout`: a newline and a tab are plain layout, so a multi-line prompt can have them. */
export const hasHiddenText = (value: string, options: { layout?: boolean } = {}): boolean => HIDDEN.test(options.layout === true ? value.replaceAll(LAYOUT, "") : value);

/** The text with every hidden character shown as `?`. */
export const showHidden = (value: string): string => value.replaceAll(HIDDEN_EVERYWHERE, "?");
