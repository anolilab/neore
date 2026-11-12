const LEADING_NEWLINES = /^\n*/;
const TRAILING_NEWLINE_BLOCK_START = /^[\t\r\n]+/;

export function repeat(character: string, count: number): string {
    return character.repeat(count);
}

export function trimLeadingNewlines(string: string): string {
    return string.replace(LEADING_NEWLINES, "");
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

export function hasVoid(node: Node): boolean {
    return hasDescendant(node, voidElements);
}

export function hasMeaningfulWhenBlank(node: Node): boolean {
    return hasDescendant(node, meaningfulWhenBlankElements);
}

function hasDescendant(node: Node, tagNames: Set<string>): boolean {
    if (!("querySelector" in node) || typeof node.querySelector !== "function") {
        return false;
    }

    const element = node as Element;

    for (const tagName of tagNames) {
        // Truthiness, not `!== null`: domino returns undefined when nothing matches.
        if (element.querySelector(tagName)) {
            return true;
        }
    }

    return false;
}

/**
 * Escapes text so that it cannot start a Markdown block or open an inline
 * construct. Order matters: the backslash is escaped first.
 */
export function escapeMarkdown(string: string): string {
    return string
        .replaceAll("\\", "\\\\")
        .replaceAll("*", String.raw`\*`)
        .replaceAll(/^-/g, String.raw`\-`)
        .replaceAll(/^\+ /g, String.raw`\+ `)
        .replaceAll(/^(=+)/g, String.raw`\$1`)
        .replaceAll(/^(#{1,6}) /g, String.raw`\$1 `)
        .replaceAll("`", "\\`")
        .replaceAll(/^~~~/g, String.raw`\~~~`)
        .replaceAll("[", String.raw`\[`)
        .replaceAll("]", String.raw`\]`)
        .replaceAll(/^>/g, String.raw`\>`)
        .replaceAll("_", String.raw`\_`)
        .replaceAll(/^(\d+)\. /g, String.raw`$1\. `);
}
