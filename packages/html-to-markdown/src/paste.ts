/**
 * A preset for converting pasted HTML in a chat composer: `new TurndownService(PASTE_OPTIONS).use(paste)`.
 *
 * Pasted HTML is untrusted and was laid out for a page, not for Markdown. The preset leaves out what the page does not
 * show (hidden text, scripts, media, form controls), keeps an emoji's or a formula's text where an image draws it, and
 * writes the rest as GitHub Flavored Markdown (it uses the `gfm` plugin) in the forms people type in a composer.
 */
import { gfm } from "./gfm";
import type TurndownService from "./turndown";
import type { FilterFunction, Options, Rule, RuleLookup } from "./types";
import { parseListStart, trimNewlines } from "./utilities";

/**
 * The options the preset is written for. A line break is a plain newline, with no trailing spaces a composer would
 * hide; lists use `- `; code is fenced; links whose destination is not safe are written as their text.
 */
export const PASTE_OPTIONS: Partial<Options> = {
    br: "",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    hr: "---",
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
const OUTER_DISPLAY = new Set(["block", "inline", "run-in"]);
const INNER_DISPLAY = new Set(["flex", "flow", "flow-root", "grid", "ruby", "table"]);
// How a character changes the depth of parentheses a style's reader is in.
const DEPTH_CHANGE: Readonly<Record<string, number>> = { "(": 1, ")": -1 };
const QUOTES = new Set(["'", `"`]);

/**
 * The value an inline style gives a property, as CSS reads it: the last declaration wins, unless an earlier one is
 * `!important` and the later one is not. Lower case, without `!important`; empty when the style sets none.
 */
export function declaredStyle(style: string, property: string, isValid: (value: string) => boolean = () => true): string {
    let value = "";
    let isImportant = false;

    const parts = declarations(style);

    for (const declaration of parts) {
        const colon = declaration.indexOf(":");

        if (colon === -1 || declaration.slice(0, colon).trim().toLowerCase() !== property) {
            continue;
        }

        const raw = declaration.slice(colon + 1);
        const { isImportant: isThisImportant, value: candidate } = priority(raw);

        // A browser drops a declaration whose value it cannot read, so an invalid value overrides nothing.
        if ((isThisImportant || !isImportant) && isValid(candidate)) {
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

/** True when the page does not show the element: hidden by an attribute, a style or a screen-reader class, or no text. */
export function isHiddenElement(node: Node): boolean {
    if (node.nodeType !== 1) {
        return false;
    }

    const element = node as Element;

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

/** True when one of the image's classes has `math` as a word of its own, as `math` or `mwe-math-fallback` does. */
function isFormulaImage(image: Element): boolean {
    return (image.getAttribute("class") ?? "").split(" ").some((name) => name.toLowerCase().split("-").includes("math"));
}

/** True for a dialog that is not open, and for what a closed details holds besides its summary: the page shows neither. */
function isClosedContent(element: Element): boolean {
    if (element.localName === "dialog") {
        return !element.hasAttribute("open");
    }

    const parent = element.parentNode as Element | null;

    return parent?.nodeName === "DETAILS" && !parent.hasAttribute("open") && element !== summaryOf(parent);
}

/** A details element's summary: its first summary child, as the page shows it. */
function summaryOf(details: Element): Element | null {
    for (let child = details.firstElementChild; child; child = child.nextElementSibling) {
        if (child.nodeName === "SUMMARY") {
            return child;
        }
    }

    return null;
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
    const alt = image.getAttribute("alt")?.trim() ?? "";

    if (alt !== "" && isFormulaImage(image)) {
        return inlineMath(alt);
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

/** A filter that matches only what no remove filter drops: the preset's rules are added, so they come before those. */
function unlessRemoved(isMatch: (node: Element) => boolean): FilterFunction {
    return (node, _options, lookup) => isMatch(node) && !lookup.isRemoved(node);
}

const pasteRules: Record<string, Rule> = {
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

    // A list item written with the marker and one space, as people type it; its later lines are indented to its text.
    listItem: {
        filter: unlessRemoved((node) => node.nodeName === "LI"),
        replacement(content, node, options, lookup) {
            const parent = node.parentNode as Element | null;
            const marker = parent?.nodeName === "OL" ? `${itemNumber(parent, node, lookup)}.` : options.bulletListMarker;

            const prefix = `${marker} `;
            const body = trimNewlines(content).replaceAll("\n", () => `\n${" ".repeat(prefix.length)}`);

            return `${prefix}${body}${node.nextSibling ? "\n" : ""}`;
        },
    },

    // A formula with a TeX source is written as inline math. Without one, its visible text stays (its other annotations
    // are skipped).
    math: {
        filter: unlessRemoved((node) => node.nodeName.toUpperCase() === "MATH" && Boolean(texSource(node))),
        replacement: (_content, node) => inlineMath(texSource(node)),
    },
};

// Each ordered list's item numbers, worked out once for the list, so a long list is numbered in one pass.
const itemNumbers = new WeakMap<Element, Map<Element, bigint>>();

/**
 * The number HTML gives the item: the list's `start`, or the item's own `value`, counting up from there. An item a remove
 * filter drops takes no number.
 */
function itemNumber(list: Element, item: Element, lookup: RuleLookup): bigint {
    let numbers = itemNumbers.get(list);

    if (!numbers) {
        numbers = new Map();

        let next = parseListStart(list.getAttribute("start")) ?? 1n;

        for (let child = list.firstElementChild; child; child = child.nextElementSibling) {
            if (child.nodeName !== "LI" || lookup.isRemoved(child)) {
                continue;
            }

            next = parseListStart(child.getAttribute("value")) ?? next;
            numbers.set(child, next);
            next += 1n;
        }

        itemNumbers.set(list, numbers);
    }

    return numbers.get(item) ?? 1n;
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

    for (const [key, rule] of Object.entries(pasteRules)) {
        service.addRule(key, rule);
    }

    // Added last, so it comes first: inside a table cell its rules write a list as the cell's text.
    service.use(gfm);
}
