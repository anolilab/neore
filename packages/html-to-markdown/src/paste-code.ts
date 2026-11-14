/**
 * Code blocks for the paste preset. Every `<pre>` is fenced, with or without a `<code>` inside it: editors and terminals
 * copy code as a bare `<pre>`. The text is read from the DOM as the page shows it, and the language from a class on
 * the code, the block or the two elements around it, as GitHub and highlighters write it.
 */
import { declaredStyle } from "./inline-style";
import { unlessRemoved } from "./paste-lists";
import type { Rule, RuleLookup } from "./types";

// `language-js`, `lang-js`, and GitHub's `highlight-source-shell` (or `highlight-js`) on the element around the block.
// Longest first, so `highlight-source-shell` is read as `shell`.
const LANGUAGE_PREFIXES = ["highlight-source-", "highlight-", "language-", "lang-"];
// On the elements around the block only the prefixes that name a language and nothing else: `lang-en` or
// `highlight-yellow` on a page wrapper is a locale or a color.
const WRAPPER_PREFIXES = ["highlight-source-", "language-"];
const LANGUAGE_NAME = /^[\w#+.-]{1,30}$/;
const CLASS_SEPARATOR = /[\t\n\f\r ]+/;
// Elements that start a line of their own inside a code block, as a page shows them.
const LINE_ELEMENTS = new Set([
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
    "HR",
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
// Display types that keep an element in its line, and those that put it on lines of its own.
const INLINE_DISPLAYS = new Set(["contents", "inline", "inline-block", "inline-flex", "inline-grid", "inline-table", "ruby", "ruby-base", "ruby-text"]);
const BLOCK_DISPLAYS = new Set(["block", "flex", "flow-root", "grid", "list-item", "table", "table-caption", "table-row", "table-row-group"]);
const DISPLAY_SPACE = /[\t\n\f\r ]+/;
const BACKTICK_RUN = /`+/g;
const MIN_FENCE = 3;

/** The language a class names on the code, the block, or the two elements around it, in lower case; or "". */
function languageOf(pre: Element, lookup: RuleLookup): string {
    const parent = pre.parentElement;

    for (const element of [shownCode(pre, lookup), pre]) {
        const language = classLanguage(element?.getAttribute("class") ?? "", LANGUAGE_PREFIXES);

        if (language !== "") {
            return language;
        }
    }

    for (const element of [parent, parent?.parentElement]) {
        const language = classLanguage(element?.getAttribute("class") ?? "", WRAPPER_PREFIXES);

        if (language !== "") {
            return language;
        }
    }

    return "";
}

/** The first `<code>` in the block that the page shows: a hidden one's language is not the shown code's. */
function shownCode(pre: Element, lookup: RuleLookup): Element | null {
    // One walk down the block in order, past hidden elements and all they hold: each element is read once.
    const pending: Element[] = [];

    pushElementChildren(pending, pre);

    while (pending.length > 0) {
        const element = pending.pop() as Element;

        if (lookup.isRemoved(element)) {
            continue;
        }

        if (element.nodeName === "CODE") {
            return element;
        }

        pushElementChildren(pending, element);
    }

    return null;
}

/** Pushes the element's child elements, last first, so the first comes off the stack first. */
function pushElementChildren(pending: Element[], element: Element): void {
    for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
        pending.push(child);
    }
}

/** The language the first class with a language prefix names, in lower case; or "". */
function classLanguage(classes: string, prefixes: ReadonlyArray<string>): string {
    for (const name of classes.toLowerCase().split(CLASS_SEPARATOR)) {
        const prefix = prefixes.find((candidate) => name.startsWith(candidate));
        const language = prefix === undefined ? "" : name.slice(prefix.length);

        // GitHub's `highlight-source` names no language on its own.
        if (language !== "source" && LANGUAGE_NAME.test(language)) {
            return language;
        }
    }

    return "";
}

/** A step of the walk over a code block: an element or text to read, or the end of a line element. */
type Step = { node: Node } | { lineEnd: true };

/**
 * The text of a code block as the page shows it, whitespace kept: no hidden parts, a line per `<br>` and per line
 * element. Read in one walk without recursion, so deep nesting costs no stack.
 */
function codeText(pre: Element, lookup: RuleLookup, imageAlt: (image: Element) => string): string {
    const parts: string[] = [];
    let hasNewlineEnd = false;
    // A line element ends its line: what follows it, text or another element, starts the next one.
    let isLineEnded = false;
    const push = (part: string): void => {
        if (part === "") {
            return;
        }

        if (isLineEnded && !hasNewlineEnd) {
            parts.push("\n");
        }

        isLineEnded = false;
        parts.push(part);
        hasNewlineEnd = part.endsWith("\n");
    };
    const steps: Step[] = [];

    pushChildren(steps, pre);

    while (steps.length > 0) {
        const step = steps.pop() as Step;

        if ("lineEnd" in step) {
            isLineEnded = true;
            continue;
        }

        const { node } = step;
        const leaf = leafText(node, lookup, imageAlt);

        if (leaf !== undefined) {
            push(leaf);
            continue;
        }

        const isLine = isLineElement(node as Element);

        if (!hasNewlineEnd && isLine && parts.length > 0) {
            // The one break between the two lines: the one the line before asked for is this one.
            isLineEnded = false;
            push("\n");
        }

        if (isLine) {
            steps.push({ lineEnd: true });
        }

        pushChildren(steps, node);
    }

    // Only the line break that ends the last line: a blank line the code ends with stays, as the built-in rule keeps it.
    const code = parts.join("");

    return code.endsWith("\n") ? code.slice(0, -1) : code;
}

/**
 * True when the element starts a line of its own: by its style's display type, as the page shows it, or by its name
 * when the style sets none it knows.
 */
function isLineElement(element: Element): boolean {
    const style = element.getAttribute("style") ?? "";
    const display = style === "" ? "" : declaredStyle(style, "display");
    const outer = display.split(DISPLAY_SPACE)[0] ?? "";

    if (INLINE_DISPLAYS.has(outer)) {
        return false;
    }

    return BLOCK_DISPLAYS.has(outer) || LINE_ELEMENTS.has(element.nodeName);
}

/**
 * The text a node adds to a code block when it holds no lines of its own: text and CDATA (which a DOM passed in may
 * hold) as written, a line break, an image's emoji or formula, and "" for a hidden element or a comment. Undefined for
 * an element whose children are read.
 */
function leafText(node: Node, lookup: RuleLookup, imageAlt: (image: Element) => string): string | undefined {
    if (node.nodeType === 3 || node.nodeType === 4) {
        return node.nodeValue ?? "";
    }

    if (node.nodeType !== 1 || lookup.isRemoved(node)) {
        return "";
    }

    if (node.nodeName === "BR") {
        return "\n";
    }

    // An image is the emoji or formula its alt text names, as code writes it: the text alone.
    return node.nodeName === "IMG" ? imageAlt(node as Element) : undefined;
}

/** Pushes the node's children, last first, so the first comes off the stack first. */
function pushChildren(steps: Step[], node: Node): void {
    for (let child = node.lastChild; child; child = child.previousSibling) {
        steps.push({ node: child });
    }
}

/** A fence of backticks longer than any run of them in the code, and at least three. */
function fenceFor(code: string): string {
    let longest = 0;

    for (const [run] of code.matchAll(BACKTICK_RUN)) {
        longest = Math.max(longest, run.length);
    }

    return "`".repeat(Math.max(MIN_FENCE, longest + 1));
}

/** The code rules. `imageAlt` gives the text an image stands for, or "" for one that is no text. */
export function codeRules(imageAlt: (image: Element) => string): Record<string, Rule> {
    return {
        codeBlock: {
            filter: unlessRemoved((node) => node.nodeName === "PRE"),
            replacement(_content, node, _options, lookup) {
                const code = codeText(node, lookup, imageAlt);
                const fence = fenceFor(code);

                return `\n\n${fence}${languageOf(node, lookup)}\n${code}\n${fence}\n\n`;
            },
        },
    };
}
