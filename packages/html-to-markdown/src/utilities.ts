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
const SIGN = /^[+-]/;

const MAX_LIST_START_DIGITS = 40;

/**
 * Reads an `<ol start>` value as HTML does. The leading integer counts and anything
 * after it is ignored, so "3x" and "3.7" give 3. Null when there is no integer.
 * A BigInt, not a number: a long start would print as `1e+21`, or as `Infinity`
 * past about 309 digits, and one above 2^53 would lose its last digits. A run of
 * more than MAX_LIST_START_DIGITS digits gives null, so the list is numbered from 1.
 */
export function parseListStart(value: string | null): bigint | null {
    const match = value ? LEADING_INTEGER.exec(value) : null;

    if (!match) {
        return null;
    }

    // Each marker and indent copies the start, so output size is digits times items.
    if ((match[1] ?? "").replace(SIGN, "").length > MAX_LIST_START_DIGITS) {
        return null;
    }

    return BigInt(match[1] ?? "0");
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
