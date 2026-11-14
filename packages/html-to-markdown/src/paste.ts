/**
 * A preset for converting pasted HTML in a chat composer: `new TurndownService(PASTE_OPTIONS).use(paste)`.
 *
 * Pasted HTML is untrusted and was laid out for a page, not for Markdown. The preset leaves out what the page does not
 * show (hidden text, scripts, media, form controls), keeps an emoji's or a formula's text where an image draws it, and
 * writes the rest as GitHub Flavored Markdown (it uses the `gfm` plugin) in the forms people type in a composer.
 */
import { gfm } from "./gfm";
import { declaredStyle } from "./inline-style";
import { codeRules } from "./paste-code";
import { checkWork, shownText, wrapLooseListText } from "./paste-input";
import { isWordMarker, LINE_BREAK_MARK, listRules, prefixLines, trimBreaks, unlessRemoved } from "./paste-lists";
import { guardMarks, isSetToNormal, styleRules } from "./paste-styles";
import type TurndownService from "./turndown";
import type { Options, Rule } from "./types";
import { isBlock } from "./utilities";

/**
 * The options the preset is written for. A line break is a plain newline, with no trailing spaces a composer would
 * hide (the preset takes out the mark it writes before it); lists use `- `; code is fenced, and inline code keeps the
 * spaces it holds; links whose destination is not safe are written as their text.
 */
export const PASTE_OPTIONS: Partial<Options> = {
    br: LINE_BREAK_MARK,
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    hr: "---",
    preformattedCode: true,
    safeLinks: true,
};

// Elements whose content is not text the page shows: code, media, form controls, embedded documents, and the source
// annotations of a formula.
const SKIPPED = new Set([
    "annotation",
    "annotation-xml",
    "audio",
    "button",
    "canvas",
    "embed",
    "head",
    "iframe",
    "link",
    "meta",
    "noscript",
    "object",
    "script",
    "select",
    "style",
    "svg",
    "template",
    "textarea",
    "title",
    "video",
]);
// The whitespace that separates the classes in a class attribute.
const HTML_SPACE = /[\t\n\f\r ]+/;
const HIDDEN_CLASS = /(?:^|\s)(?:sr-only|visually-?hidden)(?:\s|$)/i;
const EMOJI_NAME = /^:[\w+-]{1,40}:$/;
// A pictograph, or a flag: a pair of regional indicator letters, which holds no pictograph.
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u;
// Only emoji: pictographs and the joiners, modifiers, selectors and flag letters that build them.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const MAX_EMOJI_ALT = 16;
// The keywords a `display` value is made of: one, or the two- and three-keyword forms such as `inline flow`.
const DISPLAY_KEYWORDS = new Set([
    "block",
    "contents",
    "flex",
    "flow",
    "flow-root",
    "grid",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "inline-table",
    "list-item",
    "none",
    "ruby",
    "ruby-base",
    "ruby-base-container",
    "ruby-text",
    "ruby-text-container",
    "run-in",
    "table",
    "table-caption",
    "table-cell",
    "table-column",
    "table-column-group",
    "table-footer-group",
    "table-header-group",
    "table-row",
    "table-row-group",
]);
const GLOBAL_VALUES = new Set(["inherit", "initial", "revert", "revert-layer", "unset"]);
const VISIBILITY_VALUES = new Set(["collapse", "hidden", "visible", ...GLOBAL_VALUES]);
const CONTENT_VISIBILITY_VALUES = new Set(["auto", "hidden", "visible", ...GLOBAL_VALUES]);
// `collapse` hides an element as `hidden` does, except in a table, where it also takes the row's or column's space.
const HIDING_VISIBILITY = new Set(["collapse", "hidden"]);
// The characters Unicode has raised and lowered forms of, so `E=mc<sup>2</sup>` stays `E=mc²` in plain Markdown.
const SCRIPT_FROM = [..."0123456789+-\u{2212}=()"];
const SUPERSCRIPTS = new Map([...SCRIPT_FROM, "n", "i"].map((char, index) => [char, [..."⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ"][index] as string]));
const SUBSCRIPTS = new Map(SCRIPT_FROM.map((char, index) => [char, [..."₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎"][index] as string]));
// Elements in raised or lowered text that are more than its characters, so it is written as it is.
const SCRIPT_STRUCTURE = new Set(["A", "BR", "CODE", "IMG", "KBD", "MATH", "SAMP", "SUB", "SUP", "TT"]);
const OUTER_DISPLAY = new Set(["block", "inline", "run-in"]);
const INNER_DISPLAY = new Set(["flex", "flow", "flow-root", "grid", "ruby", "table"]);

/**
 * True when the page does not show the element: hidden by an attribute, a style or a screen-reader class, or no text.
 * Word's list marker is left out too: the preset writes it as the item's marker.
 */
export function isHiddenElement(node: Node): boolean {
    return node.nodeType === 1 && (isWordMarker(node as Element) || isHiddenOnPage(node as Element));
}

/** True when the page does not show the element. */
function isHiddenOnPage(element: Element): boolean {
    if (SKIPPED.has(element.localName) || element.hasAttribute("hidden") || isClosedContent(element)) {
        return true;
    }

    if (element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" || HIDDEN_CLASS.test(element.getAttribute("class") ?? "")) {
        return true;
    }

    const style = element.getAttribute("style") ?? "";

    if (style === "") {
        return false;
    }

    if (declaredStyle(style, "display", isDisplayValue) === "none") {
        return true;
    }

    if (HIDING_VISIBILITY.has(declaredStyle(style, "visibility", (value) => VISIBILITY_VALUES.has(value)))) {
        return true;
    }

    return declaredStyle(style, "content-visibility", (value) => CONTENT_VISIBILITY_VALUES.has(value)) === "hidden";
}

/** True for a `display` value a browser reads: a global value, or keywords it knows. */
function isDisplayValue(value: string): boolean {
    const keywords = value.split(" ").filter((keyword) => keyword !== "");

    if (keywords.length === 1) {
        return GLOBAL_VALUES.has(value) || DISPLAY_KEYWORDS.has(value);
    }

    return keywords.length > 1 && keywords.length <= 3 && isDisplayCombination(keywords);
}

/**
 * True for the keyword combinations CSS allows: one outer type, one inner type and `list-item`, each at most once, and
 * with `list-item` only a flow inner type. `none`, `contents` and the internal table and ruby types stand alone.
 */
function isDisplayCombination(keywords: ReadonlyArray<string>): boolean {
    const outer = keywords.filter((keyword) => OUTER_DISPLAY.has(keyword));
    const inner = keywords.filter((keyword) => INNER_DISPLAY.has(keyword));
    const markers = keywords.filter((keyword) => keyword === "list-item");

    if (outer.length > 1 || inner.length > 1 || markers.length > 1 || outer.length + inner.length + markers.length !== keywords.length) {
        return false;
    }

    return markers.length === 0 || inner.every((keyword) => keyword === "flow" || keyword === "flow-root");
}

/** True when one of the image's classes has `math` as a word of its own, as `math` or `mwe-math-fallback` does. */
function isFormulaImage(image: Element): boolean {
    return (image.getAttribute("class") ?? "").split(HTML_SPACE).some((name) => name.toLowerCase().split("-").includes("math"));
}

/** True for a dialog that is not open, and for what a closed details holds besides its summary: the page shows neither. */
function isClosedContent(element: Element): boolean {
    if (element.localName === "dialog") {
        return !element.hasAttribute("open");
    }

    const parent = element.parentNode as Element | null;

    return parent?.nodeName === "DETAILS" && !parent.hasAttribute("open") && element !== summaryOf(parent);
}

// Each details element's summary, found once: every child of a closed one asks for it.
const summaries = new WeakMap<Element, Element | null>();

/** A details element's summary: its first summary child, as the page shows it. */
function summaryOf(details: Element): Element | null {
    const cached = summaries.get(details);

    if (cached !== undefined) {
        return cached;
    }

    let summary: Element | null = null;

    for (let child = details.firstElementChild; child; child = child.nextElementSibling) {
        if (child.nodeName === "SUMMARY") {
            summary = child;
            break;
        }
    }

    summaries.set(details, summary);

    return summary;
}

/** Each closed details' summary text, kept until the details is written. */
const summaryTexts = new WeakMap<Node, string>();

function summaryText(summary: Element): string {
    return summaryTexts.get(summary) ?? "";
}

function isClosedDetails(node: Element): boolean {
    return node.nodeName === "DETAILS" && !node.hasAttribute("open");
}

/** The text an image stands for: an emoji's alt text, or a formula's. Any other image is not text, so it has none. */
function imageText(image: Element): string {
    const alt = imageAlt(image);

    return alt !== "" && isFormulaImage(image) ? inlineMath(alt) : alt;
}

/** The alt text of an image that draws an emoji or a formula, or "" for any other image. */
function imageAlt(image: Element): string {
    const alt = image.getAttribute("alt")?.trim() ?? "";

    if (alt !== "" && isFormulaImage(image)) {
        return alt;
    }

    return EMOJI_NAME.test(alt) || (alt.length <= MAX_EMOJI_ALT && PICTOGRAPHIC.test(alt) && EMOJI_ONLY.test(alt)) ? alt : "";
}

/**
 * The formula as inline math. Math ends at the first `$` run as long as the one it opened with, so the delimiter is one
 * `$` longer than any run inside, with a space against a `$` at either edge: a `$` in the formula cannot end it early
 * and turn the rest of its source into Markdown.
 */
function inlineMath(source: string): string {
    // A line break is whitespace in TeX, and inline math stays on one line.
    const tex = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join(" ");
    let longest = 0;
    let run = 0;

    for (const char of tex) {
        run = char === "$" ? run + 1 : 0;
        longest = Math.max(longest, run);
    }

    const fence = "$".repeat(longest + 1);
    const pad = tex.startsWith("$") || tex.endsWith("$") ? " " : "";

    return `${fence}${pad}${tex}${pad}${fence}`;
}

const pasteRules: Record<string, Rule> = {
    // A quote with no trailing space on its blank lines, which a composer would hide.
    blockquote: {
        filter: unlessRemoved((node) => node.nodeName === "BLOCKQUOTE"),
        replacement(content) {
            const quoted = trimBreaks(content);

            // A quote that holds only what the page hides writes no marker.
            return quoted.trim() === "" ? "" : `\n\n${prefixLines(quoted, "> ", ">")}\n\n`;
        },
    },

    // A closed details shows its summary alone. Its other elements are hidden; its loose text is left out here.
    closedDetails: {
        filter: unlessRemoved(isClosedDetails),
        replacement(_content, node) {
            const summary = summaryOf(node);
            const text = summary === null ? "" : summaryText(summary);

            return text === "" ? "" : `\n\n${text}\n\n`;
        },
    },

    closedSummary: {
        filter: unlessRemoved((node) => node.nodeName === "SUMMARY" && node.parentNode !== null && isClosedDetails(node.parentNode as Element)),
        replacement(content, node) {
            summaryTexts.set(node, content.trim());

            return "";
        },
    },

    // An image is an emoji's or a formula's text, or nothing: a pasted picture arrives as a file, if at all.
    image: {
        filter: unlessRemoved((node) => node.nodeName === "IMG"),
        replacement: (_content, node) => imageText(node),
    },

    // A div that holds only inline content is a line, as mail and editors write one per line: a run of them is not
    // parted by blank lines. A `<br>` that ends it makes no line of its own, so a div that holds only one is a blank line.
    lineDiv: {
        filter: unlessRemoved((node) => node.nodeName === "DIV" && !hasBlockChild(node)),
        replacement(content) {
            const text = content.endsWith(`${LINE_BREAK_MARK}\n`) ? content.slice(0, -LINE_BREAK_MARK.length - 1) : content;

            return text.trim() === "" ? "\n\n" : `\n${text}\n`;
        },
    },

    // A formula with a TeX source is written as inline math. Without one, its visible text stays (its other annotations
    // are skipped).
    math: {
        filter: unlessRemoved((node) => node.nodeName.toUpperCase() === "MATH" && Boolean(texSource(node))),
        replacement: (_content, node) => inlineMath(texSource(node)),
    },

    // Bold set back to normal weight is not bold: Google Docs wraps a whole copy in `<b style="font-weight:normal">`.
    normalWeightBold: {
        filter: unlessRemoved((node) => (node.nodeName === "B" || node.nodeName === "STRONG") && isSetToNormal(node)),
        replacement: (content) => content,
    },

    // Raised and lowered text: no Markdown writes it, so it keeps its meaning in Unicode where Unicode can.
    script: {
        filter: unlessRemoved((node) => node.nodeName === "SUP" || node.nodeName === "SUB"),
        replacement: (content, node) => scriptText(content, node, node.nodeName === "SUP" ? SUPERSCRIPTS : SUBSCRIPTS),
    },
};

/**
 * Raised or lowered text in the Unicode forms of its characters, when the page shows only text in it and each character
 * has a form; otherwise as written: an ordinal (`12<sup>th</sup>`), a footnote mark (`<sup>[1]</sup>`), or one that holds
 * a line break, a link, code, an image or raised text of its own. The characters are mapped in the Markdown, so
 * emphasis around them stays, and an escaped one is mapped without its backslash.
 */
function scriptText(content: string, node: Element, forms: ReadonlyMap<string, string>): string {
    const chars = [...shownText(node, isHiddenElement).trim()];

    if (chars.length === 0 || chars.some((char) => !forms.has(char)) || hasScriptStructure(node)) {
        return content;
    }

    const written: string[] = [];
    const contentChars = [...content];

    for (let index = 0; index < contentChars.length; index += 1) {
        const char = contentChars[index] as string;
        const next = contentChars[index + 1];
        const isEscape = char === "\\" && next !== undefined && forms.has(next);
        const mapped = isEscape ? next : char;

        written.push(forms.get(mapped) ?? mapped);
        index += isEscape ? 1 : 0;
    }

    return written.join("");
}

/** True when the element holds an element it shows that is more than text: a line break, a link, code, an image. */
function hasScriptStructure(node: Element): boolean {
    const pending: Element[] = [];

    for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        pending.push(child);
    }

    while (pending.length > 0) {
        const element = pending.pop() as Element;

        if (isHiddenElement(element)) {
            continue;
        }

        if (SCRIPT_STRUCTURE.has(element.nodeName) || isBlock(element)) {
            return true;
        }

        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
            pending.push(child);
        }
    }

    return false;
}

/** True when one of the element's children is a block, which starts a line of its own. */
function hasBlockChild(element: Element): boolean {
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (child.nodeName !== "BR" && isBlock(child)) {
            return true;
        }
    }

    return false;
}

/** A media type without its parameters, in lower case: `application/x-tex; charset=utf-8` is `application/x-tex`. */
function mediaType(value: string): string {
    return (value.split(";", 1)[0] ?? "").trim().toLowerCase();
}

/** The element's children with a local name, in order. */
function childrenNamed(element: Element, name: string): Element[] {
    const found: Element[] = [];

    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (child.localName.toLowerCase() === name) {
            found.push(child);
        }
    }

    return found;
}

/** A formula's TeX source, from its `application/x-tex` annotation, or "". */
function texSource(node: Element): string {
    // The formula's own annotations: the children of its semantics. One nested deeper, in another annotation, is a
    // source for part of it. A media type is matched without case, so `APPLICATION/X-TEX` names TeX too.
    const annotations = childrenNamed(node, "semantics").flatMap((semantics) => childrenNamed(semantics, "annotation"));

    for (const annotation of annotations) {
        const source = annotation?.textContent?.trim() ?? "";

        // The first TeX annotation with a source: an empty one says nothing about the formula.
        if (source !== "" && mediaType(annotation?.getAttribute("encoding") ?? "") === "application/x-tex") {
            return source;
        }
    }

    return "";
}

/** The paste preset: the `gfm` rules, hidden content left out, and image, formula and list rules for a composer. */
export function paste(service: TurndownService): void {
    service.remove(isHiddenElement);

    const rules = { ...pasteRules, ...listRules(isHiddenOnPage), ...codeRules(imageAlt) };

    for (const [key, rule] of Object.entries(rules)) {
        service.addRule(key, rule);
    }

    // Added after the preset's rules, so it comes before them: inside a table cell its rules write a list or a code
    // block as the cell's text.
    service.use(gfm);

    // Added last, so it comes first: a styled list item or table cell is formatted, then passed on to its rule.
    for (const [key, rule] of Object.entries(styleRules)) {
        service.addRule(key, rule);
    }

    // The loose list text is put in items first, so the work is measured on the items the conversion writes.
    guardMarks(service, (root) => {
        wrapLooseListText(root, { imageText, isHidden: isHiddenElement });
        checkWork(root, isHiddenElement);
    });
}
