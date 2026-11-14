/**
 * The text a clipboard `text/html` payload shows, for a plain paste: no Markdown added, hidden parts left out by the
 * same rules as the Markdown conversion (`isHiddenElement`), code indentation kept.
 *
 * The HTML is untrusted: it is parsed with `DOMParser` into an inert document (no scripts run, nothing loads), and only
 * its text is read.
 */
import { isHiddenElement } from "@neore/html-to-markdown";

// Elements a page shows on lines of their own.
const LINES = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "CAPTION",
    "DD",
    "DETAILS",
    "DIV",
    "DL",
    "DT",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "TR",
    "UL",
]);
const CELLS = new Set(["TD", "TH"]);
// The whitespace HTML collapses: ASCII only. `\s` would also take the non-breaking spaces Word and Google Docs indent with.
const HTML_SPACE = /[\t\n\f\r ]+/g;
const BLANK_LINES = /\n{3,}/g;
// Control characters, which show nothing and have no place in a message; the whitespace among them stays.
// eslint-disable-next-line no-control-regex -- the control characters are what it matches.
const CONTROL_CHARS = /[\u{0}-\u{8}\v\u{E}-\u{1F}\u{7F}]/gu;
const LEADING_NEWLINE = /^\n{1,2}/;
const TRAILING_NEWLINE = /\n{1,2}$/;
const EMOJI_NAME = /^:[\w+-]{1,40}:$/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Only emoji: pictographs and the joiners, modifiers, selectors and flag letters that build them.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const MAX_EMOJI_ALT = 16;
const MATH_CLASS = /math/i;
/** Elements deep the walk goes before the paste falls back to its plain text, well before the stack runs out. */
const MAX_DEPTH = 500;

const isSpace = (char: string | undefined): boolean => char === " " || char === "\t";

const trimSpacesEnd = (text: string): string => {
    let end = text.length;

    while (isSpace(text[end - 1])) {
        end -= 1;
    }

    return text.slice(0, end);
};

const trimSpacesStart = (text: string): string => {
    let start = 0;

    while (isSpace(text[start])) {
        start += 1;
    }

    return text.slice(start);
};

/** The text an image stands for: an emoji's or a formula's alt text; other images arrive as files, if at all. */
const imageText = (image: Element): string => {
    const alt = image.getAttribute("alt")?.trim() ?? "";

    if (MATH_CLASS.test(image.getAttribute("class") ?? "") && alt !== "") {
        return alt;
    }

    return EMOJI_NAME.test(alt) || (alt.length <= MAX_EMOJI_ALT && PICTOGRAPHIC.test(alt) && EMOJI_ONLY.test(alt)) ? alt : "";
};

/**
 * The text of a page as shown: HTML whitespace collapsed outside `<pre>`, a line per block, row, list item and heading,
 * a space between cells, a line per `<br>`, and no hidden parts. A closed `<details>` shows its summary alone.
 */
const pageText = (root: Node): string => {
    // One list of parts for the whole page, with the last character tracked, so no text is rebuilt per element.
    const parts: string[] = [];
    let endsWithNewline = false;
    // A line element ends its line: what follows it, text or another element, starts the next one.
    let lineEnded = false;
    const push = (part: string): void => {
        if (part === "") {
            return;
        }

        if (lineEnded && !endsWithNewline) {
            parts.push("\n");
        }

        lineEnded = false;
        parts.push(part);
        endsWithNewline = part.endsWith("\n");
    };
    const walk = (parent: Node, depth: number, inPre: boolean): void => {
        if (depth >= MAX_DEPTH) {
            throw new RangeError("Nested too deep to convert");
        }

        for (const child of parent.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                const text = (child.nodeValue ?? "").replaceAll(CONTROL_CHARS, "");

                if (inPre) {
                    push(text);
                } else {
                    const collapsed = text.replaceAll(HTML_SPACE, " ");

                    // Collapsed space at the start of a line is not shown.
                    push(parts.length === 0 || endsWithNewline || lineEnded ? trimSpacesStart(collapsed) : collapsed);
                }
            } else if (child.nodeType === Node.ELEMENT_NODE && !isHiddenElement(child)) {
                const element = child as Element;
                const { tagName } = element;
                const isLine = LINES.has(tagName);

                if (CELLS.has(tagName) && parts.length > 0 && !endsWithNewline && !lineEnded) {
                    push(" ");
                }

                if (isLine && parts.length > 0 && !endsWithNewline) {
                    // The one break between the two lines: the one the line before asked for is this one.
                    lineEnded = false;
                    push("\n");
                }

                if (tagName === "BR") {
                    push("\n");
                } else if (tagName === "IMG") {
                    push(imageText(element));
                } else if (tagName === "DETAILS" && !element.hasAttribute("open")) {
                    const summary = [...element.children].find((nested: Element) => nested.tagName === "SUMMARY");

                    if (summary && !isHiddenElement(summary)) {
                        walk(summary, depth + 1, inPre);
                    }
                } else {
                    walk(element, depth + 1, inPre || tagName === "PRE");
                }

                lineEnded ||= isLine;
            }
        }
    };

    walk(root, 0, false);

    return parts.join("");
};

/** The text a clipboard `text/html` payload shows, no Markdown added: hidden parts left out, code indentation kept. */
export const visibleText = (html: string): string =>
    pageText(new DOMParser().parseFromString(html, "text/html").body)
        .split("\n")
        .map((line: string) => trimSpacesEnd(line))
        .join("\n")
        .replaceAll(BLANK_LINES, "\n\n")
        .replace(LEADING_NEWLINE, "")
        .replace(TRAILING_NEWLINE, "");
