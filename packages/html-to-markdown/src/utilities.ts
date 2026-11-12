const TRAILING_NEWLINE_BLOCK_START = /^[\t\r\n]+/;

export function repeat(character: string, count: number): string {
    return character.repeat(count);
}

export function trimLeadingNewlines(string: string): string {
    let indexStart = 0;

    while (indexStart < string.length && string[indexStart] === "\n") {
        indexStart += 1;
    }

    return indexStart === 0 ? string : string.slice(indexStart);
}

export function trimTrailingNewlines(string: string): string {
    // avoid match-at-end regexp bottleneck, see #370
    let indexEnd = string.length;

    while (indexEnd > 0 && string[indexEnd - 1] === "\n") {
        indexEnd -= 1;
    }

    return string.slice(0, indexEnd);
}

export function trimNewlines(string: string): string {
    return trimTrailingNewlines(trimLeadingNewlines(string));
}

/** Strips leading tabs and line breaks (not spaces), as upstream's postProcess does. */
export function trimLeadingBreaks(string: string): string {
    return string.replace(TRAILING_NEWLINE_BLOCK_START, "");
}

/** The string the line-break rule emits for a hard break. */
export function lineBreakMarker(br: string): string {
    return `${br}\n`;
}

const BLANK_TEXT = /^\s*$/;

/**
 * Trims the whitespace at both ends of an element's content, as `trim` does, and
 * then writes back the hard line breaks that the element starts and ends with.
 * Those breaks are whitespace in the content, so `trim` would remove them. They
 * are counted from the DOM, not found in the string, because text can hold the
 * same characters as a break.
 */
export function trimKeepingBreaks(content: string, node: Node, br: string): string {
    const marker = lineBreakMarker(br);
    const core = content.trim();
    const lead = edgeBreaks(node, "left");
    const trail = edgeBreaks(node, "right");

    // An element that holds only breaks has the same breaks at both ends, so they are written once.
    if (core === "") {
        return marker.repeat(Math.max(lead, trail));
    }

    return marker.repeat(lead) + core + marker.repeat(trail);
}

/**
 * How many hard line breaks sit at one edge of an element, counting through
 * inline children. Whitespace-only text and comments are skipped. An inline child
 * is counted only while it holds nothing but breaks, so the run stops at text.
 */
export function edgeBreaks(node: Node, side: "left" | "right"): number {
    let count = 0;
    let child = side === "left" ? node.firstChild : node.lastChild;

    while (child) {
        if (child.nodeName === "BR") {
            count += 1;
        } else if (child.nodeType === 1 && !isBlock(child) && !isVoid(child)) {
            count += edgeBreaks(child, side);

            if (!hasOnlyBreaks(child)) {
                break;
            }
        } else if (!isIgnorableEdge(child)) {
            break;
        }

        child = side === "left" ? child.nextSibling : child.previousSibling;
    }

    return count;
}

function isIgnorableEdge(node: Node): boolean {
    if (node.nodeType === 8) {
        return true;
    }

    return (node.nodeType === 3 || node.nodeType === 4) && BLANK_TEXT.test(node.nodeValue ?? "");
}

/** True when the node's content is only whitespace and line breaks, so it outputs no text. */
export function hasOnlyBreaks(node: Node): boolean {
    for (const child of node.childNodes) {
        if (child.nodeName === "BR") {
            continue;
        }

        if (child.nodeType === 1) {
            if (isVoid(child) || !hasOnlyBreaks(child)) {
                return false;
            }
        } else if (!isIgnorableEdge(child) && child.nodeType !== 8) {
            return false;
        }
    }

    return true;
}

/** Removes the spaces at both ends of a string. Other whitespace, such as a newline, stays. */
function trimSpaces(text: string): string {
    let start = 0;
    let end = text.length;

    while (start < end && text[start] === " ") {
        start += 1;
    }

    while (end > start && text[end - 1] === " ") {
        end -= 1;
    }

    return text.slice(start, end);
}

/**
 * Replaces each break marker with a space, for text that must stay on one line.
 * A marker followed by a newline sits next to a block, so it becomes a newline
 * and the block separator keeps its newlines. Spaces next to a marker are trimmed.
 */
export function flattenBreaks(content: string, marker: string): string {
    if (!marker || !content.includes(marker)) {
        return content;
    }

    const [first = "", ...parts] = content.split(marker);
    let text = first;

    for (const part of parts) {
        const separator = part.startsWith("\n") ? "\n" : " ";

        text = trimSpaces(text) + separator + trimSpaces(part);
    }

    return trimSpaces(text);
}

/**
 * The text of a code element. Each line break element becomes a newline, which
 * is how a line break is written inside a code block; otherwise it is the same
 * text that textContent gives.
 */
export function codeText(node: Node): string {
    let text = "";

    for (const child of node.childNodes) {
        if (child.nodeName === "BR") {
            text += "\n";
        } else if (child.nodeType === 1) {
            text += codeText(child);
        } else if (child.nodeType === 3 || child.nodeType === 4) {
            text += child.nodeValue ?? "";
        }
    }

    return text;
}

const blockElements = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "AUDIO",
    "BLOCKQUOTE",
    "BODY",
    "CANVAS",
    "CENTER",
    "DD",
    "DIR",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "FRAMESET",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HGROUP",
    "HR",
    "HTML",
    "ISINDEX",
    "LI",
    "MAIN",
    "MENU",
    "NAV",
    "NOFRAMES",
    "NOSCRIPT",
    "OL",
    "OUTPUT",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
]);

export function isBlock(node: Node): boolean {
    return blockElements.has(node.nodeName);
}

const voidElements = new Set([
    "AREA",
    "BASE",
    "BR",
    "COL",
    "COMMAND",
    "EMBED",
    "HR",
    "IMG",
    "INPUT",
    "KEYGEN",
    "LINK",
    "META",
    "PARAM",
    "SOURCE",
    "TRACK",
    "WBR",
]);

export function isVoid(node: Node): boolean {
    return voidElements.has(node.nodeName);
}

const meaningfulWhenBlankElements = new Set(["A", "AUDIO", "IFRAME", "SCRIPT", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "VIDEO"]);

export function isMeaningfulWhenBlank(node: Node): boolean {
    return meaningfulWhenBlankElements.has(node.nodeName);
}

const voidOrMeaningfulNames = new Set<string>(voidElements);

for (const name of meaningfulWhenBlankElements) {
    voidOrMeaningfulNames.add(name);
}

type DescendantScan = "match" | "none" | "unknown";

/**
 * True when the node has a descendant that is void or meaningful when blank.
 *
 * Walks the tree rather than querying it: domino compiles a selector on every
 * query. A name lookup is exact for upper-case names without a prefix, which is
 * every element the HTML parsers create. Anything else (a prefixed name, which a
 * type selector matches by local name, or a foreign name in another case) is
 * decided by upstream's own per-name queries, so the answer is upstream's in
 * both environments.
 */
export function hasVoidOrMeaningfulDescendant(node: Node): boolean {
    if (!("querySelector" in node) || typeof node.querySelector !== "function") {
        return false;
    }

    const scan = scanDescendants(node);

    if (scan === "unknown") {
        return hasListedDescendantByName(node as Element);
    }

    return scan === "match";
}

/**
 * One query per name, as upstream does. A joined selector list gives a different
 * answer for prefixed elements under domino, so it is not used.
 */
function hasListedDescendantByName(element: Element): boolean {
    for (const name of voidOrMeaningfulNames) {
        // Truthiness, not `!== null`: domino returns undefined when nothing matches.
        if (element.querySelector(name)) {
            return true;
        }
    }

    return false;
}

function scanDescendants(parent: Node): DescendantScan {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) {
            continue;
        }

        const { nodeName } = child;
        const upperName = nodeName.toUpperCase();

        // A prefixed name is matched by its local name, so the name here says nothing about it.
        // A foreign name in other case is listed only when upper-cased, and the case
        // rules then decide it. Any other name cannot match in either environment.
        if (nodeName.includes(":") || (nodeName !== upperName && voidOrMeaningfulNames.has(upperName))) {
            return "unknown";
        }

        if (voidOrMeaningfulNames.has(nodeName)) {
            return "match";
        }

        const inside = scanDescendants(child);

        if (inside !== "none") {
            return inside;
        }
    }

    return "none";
}

// The HTML "rules for parsing integers": ASCII whitespace, an optional sign, then digits.
const LEADING_INTEGER = /^[\t\n\f\r ]*([+-]?\d+)/;

/**
 * Reads an `<ol start>` value as HTML does. The leading integer counts and anything
 * after it is ignored, so "3x" and "3.7" give 3. Null when there is no integer.
 * A BigInt, not a number: a long start would print as `1e+21`, or as `Infinity`
 * past about 309 digits, and one above 2^53 would lose its last digits.
 */
export function parseListStart(value: string | null): bigint | null {
    const match = value ? LEADING_INTEGER.exec(value) : null;

    return match ? BigInt(match[1] ?? "0") : null;
}

const INLINE_SYNTAX = /[\\*`[\]_]/g;
const INLINE_SYNTAX_PRESENT = /[\\*`[\]_]/;

// The line-start markers, anchored and non-global. Their first characters differ, so
// at most one can match. An ordered-list number is handled apart: its dot is escaped.
const LINE_START = /^(?:-|\+ |=+|#{1,6} |~~~|>)/;
const ORDERED_START = /^(\d+)\. /;

/**
 * Escapes text so that it cannot start a Markdown block or open an inline
 * construct.
 *
 * Every inline character gets one backslash in a single pass. The backslash is
 * one of those characters, so this equals escaping it first, as upstream does.
 * The line-start rules anchor at the start of the string, and each one starts
 * with a character the inline pass never changes, so the order does not matter.
 */
export function escapeMarkdown(string: string): string {
    const inline = INLINE_SYNTAX_PRESENT.test(string) ? string.replaceAll(INLINE_SYNTAX, String.raw`\$&`) : string;

    // After the inline pass, a string that starts with a backslash matches no
    // line-start rule, so matching on the escaped string is exact.
    if (ORDERED_START.test(inline)) {
        return inline.replace(ORDERED_START, String.raw`$1\. `);
    }

    return inline.replace(LINE_START, String.raw`\$&`);
}
