/**
 * Code blocks for the paste preset. Every `<pre>` is fenced, with or without a `<code>` inside it: editors and terminals
 * copy code as a bare `<pre>`. The text is read from the DOM as the page shows it, and the language from a class on
 * the code, the block or the two elements around it, as GitHub and highlighters write it.
 */
import { unlessRemoved } from "./paste-lists";
import type { Rule, RuleLookup } from "./types";

// `language-js`, `lang-js`, and GitHub's `highlight-source-shell` (or `highlight-js`) on the element around the block.
// Longest first, so `highlight-source-shell` is read as `shell`.
const LANGUAGE_PREFIXES = ["highlight-source-", "highlight-", "language-", "lang-"];
const LANGUAGE_NAME = /^[\w#+.-]{1,30}$/;
const CLASS_SEPARATOR = /[\t\n\f\r ]+/;
// Elements that start a line of their own inside a code block, as a page shows them.
const LINE_ELEMENTS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "CAPTION",
    "DD",
    "DETAILS",
    "DIV",
    "DL",
    "DT",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "HEADER",
    "MAIN",
    "NAV",
    "P",
    "SECTION",
    "SUMMARY",
]);
const BACKTICK_RUN = /`+/g;
const MIN_FENCE = 3;

/** The language a class names on the code, the block, or the two elements around it, in lower case; or "". */
function languageOf(pre: Element, lookup: RuleLookup): string {
    const parent = pre.parentElement;

    for (const element of [shownCode(pre, lookup), pre, parent, parent?.parentElement]) {
        const language = classLanguage(element?.getAttribute("class") ?? "");

        if (language !== "") {
            return language;
        }
    }

    return "";
}

/** The first `<code>` in the block that the page shows: a hidden one's language is not the shown code's. */
function shownCode(pre: Element, lookup: RuleLookup): Element | null {
    const found = pre.querySelectorAll("code");
    // Copied by index: domino's NodeList is not iterable.
    const codes = Array.from({ length: found.length }, (_unused, index) => found[index] as Element);

    for (const code of codes) {
        let isShown = true;

        for (let element: Element | null = code; element && element !== pre && isShown; element = element.parentElement) {
            isShown = !lookup.isRemoved(element);
        }

        if (isShown) {
            return code;
        }
    }

    return null;
}

/** The language the first class with a language prefix names, in lower case; or "". */
function classLanguage(classes: string): string {
    for (const name of classes.toLowerCase().split(CLASS_SEPARATOR)) {
        const prefix = LANGUAGE_PREFIXES.find((candidate) => name.startsWith(candidate));
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
function codeText(pre: Element, lookup: RuleLookup): string {
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

        // Text, and CDATA, which a DOM passed in may hold.
        if (node.nodeType === 3 || node.nodeType === 4) {
            push(node.nodeValue ?? "");
            continue;
        }

        if (node.nodeType !== 1 || lookup.isRemoved(node)) {
            continue;
        }

        if (node.nodeName === "BR") {
            push("\n");
            continue;
        }

        const isLine = LINE_ELEMENTS.has(node.nodeName);

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

export const codeRules: Record<string, Rule> = {
    codeBlock: {
        filter: unlessRemoved((node) => node.nodeName === "PRE"),
        replacement(_content, node, _options, lookup) {
            const code = codeText(node, lookup);
            const fence = fenceFor(code);

            return `\n\n${fence}${languageOf(node, lookup)}\n${code}\n${fence}\n\n`;
        },
    },
};
