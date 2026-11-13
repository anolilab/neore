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
const IMPORTANT = /!\s{0,20}important\s{0,20}$/i;
const MATH_CLASS = /math/i;
const EMOJI_NAME = /^:[\w+-]{1,40}:$/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Only emoji: pictographs and the joiners, modifiers, selectors and flag letters that build them.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const MAX_EMOJI_ALT = 16;

/**
 * The value an inline style gives a property, as CSS reads it: the last declaration wins, unless an earlier one is
 * `!important` and the later one is not. Lower case, without `!important`; empty when the style sets none.
 */
export function declaredStyle(style: string, property: string): string {
    let value = "";
    let isImportant = false;

    for (const declaration of style.split(";")) {
        const colon = declaration.indexOf(":");

        if (colon === -1 || declaration.slice(0, colon).trim().toLowerCase() !== property) {
            continue;
        }

        const raw = declaration.slice(colon + 1);
        const isThisImportant = IMPORTANT.test(raw);

        if (isThisImportant || !isImportant) {
            value = raw.replace(IMPORTANT, "").trim().toLowerCase();
            isImportant = isThisImportant;
        }
    }

    return value;
}

/** True when the page does not show the element: hidden by an attribute, a style or a screen-reader class, or no text. */
export function isHiddenElement(node: Node): boolean {
    if (node.nodeType !== 1) {
        return false;
    }

    const element = node as Element;

    if (SKIPPED.has(element.localName) || element.hasAttribute("hidden")) {
        return true;
    }

    if (element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" || HIDDEN_CLASS.test(element.getAttribute("class") ?? "")) {
        return true;
    }

    const style = element.getAttribute("style") ?? "";

    return style !== "" && (declaredStyle(style, "display") === "none" || declaredStyle(style, "visibility") === "hidden");
}

/** The text an image stands for: an emoji's alt text, or a formula's. Any other image is not text, so it has none. */
function imageText(image: Element): string {
    const alt = image.getAttribute("alt")?.trim() ?? "";

    if (alt !== "" && MATH_CLASS.test(image.getAttribute("class") ?? "")) {
        return inlineMath(alt);
    }

    return EMOJI_NAME.test(alt) || (alt.length <= MAX_EMOJI_ALT && PICTOGRAPHIC.test(alt) && EMOJI_ONLY.test(alt)) ? alt : "";
}

/**
 * The formula as inline math. Math ends at the first `$` run as long as the one it opened with, so the delimiter is one
 * `$` longer than any run inside, with a space against a `$` at either edge: a `$` in the formula cannot end it early
 * and turn the rest of its source into Markdown.
 */
function inlineMath(tex: string): string {
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
            let marker = options.bulletListMarker;

            if (parent?.nodeName === "OL") {
                const start = parseListStart(parent.getAttribute("start")) ?? 1n;

                marker = `${start + BigInt(keptItemsBefore(node, lookup))}.`;
            }

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

/** How many list items before this one a remove filter keeps: a hidden item takes no number. */
function keptItemsBefore(item: Element, lookup: RuleLookup): number {
    let count = 0;

    for (let previous = item.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.nodeName === "LI" && !lookup.isRemoved(previous)) {
            count += 1;
        }
    }

    return count;
}

/** A formula's TeX source, from its `application/x-tex` annotation, or "". */
function texSource(node: Element): string {
    return node.querySelector(`annotation[encoding="application/x-tex"]`)?.textContent?.trim() ?? "";
}

/** The paste preset: the `gfm` rules, hidden content left out, and image, formula and list rules for a composer. */
export function paste(service: TurndownService): void {
    service.use(gfm);
    service.remove(isHiddenElement);

    for (const [key, rule] of Object.entries(pasteRules)) {
        service.addRule(key, rule);
    }
}
