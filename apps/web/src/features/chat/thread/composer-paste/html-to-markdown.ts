/**
 * Clipboard HTML → Markdown for the composer. Loaded with `import()` only when a paste carries HTML.
 *
 * The HTML is untrusted: it is parsed with `DOMParser` into an inert document (no scripts run, nothing loads), only its
 * text is read, and the result goes into the editor as text, never as HTML.
 */

/* eslint-disable @typescript-eslint/no-use-before-define -- children() and element() walk the tree by calling each other */

import { fenceCode, longestBacktickRun } from "./paste-plan";

const SKIPPED = new Set([
    "AUDIO",
    "BUTTON",
    "CANVAS",
    "EMBED",
    "HEAD",
    "IFRAME",
    "IMG",
    "LINK",
    "MATH",
    "META",
    "NOSCRIPT",
    "OBJECT",
    "PICTURE",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEMPLATE",
    "TEXTAREA",
    "TITLE",
    "VIDEO",
]);
const BLOCKS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "DD",
    "DETAILS",
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
const LINE_BLOCKS = new Set(["CAPTION", "DIV"]);
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const LANGUAGE_CLASS = /(?:^|\s)(?:language|lang|highlight-source|highlight)-([\w#+.-]{1,30})/;
const BOLD_STYLE = /font-weight\s*:\s*(?:bold|[6-9]00)/i;
const NORMAL_WEIGHT = /font-weight\s*:\s*(?:normal|[1-4]00)/i;
const ITALIC_STYLE = /font-style\s*:\s*italic/i;
const STRIKE_STYLE = /text-decoration[\w-]*\s*:[^;]*line-through/i;
const HIDDEN_STYLE = /display\s*:\s*none|mso-list\s*:\s*ignore/i;
const WORD_LIST_LEVEL = /mso-list\s*:[^;]*level(\d)/i;
const WORD_ORDERED_MARKER = /^\s*\w{1,4}[.)]/;
const WORD_LIST_BULLET = /mso-list\s*:\s*ignore/i;
const HEADING = /^H[1-6]$/;
const BLANK_LINES = /\n{3,}/g;
const PLACEHOLDER = /\0(\d+)\0/g;

interface Context {
    /** Fenced code blocks, put back at the end so whitespace clean-up never touches them. */
    code: string[];
    inTable: boolean;
}

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

/** The lines of `text` trimmed and joined with spaces: a table cell, a heading or inline code is one line. */
const oneLine = (text: string): string =>
    text
        .split("\n")
        .map((line: string) => line.trim())
        .join(" ");

/** Appends `next` to `out`, dropping the spaces that collapsed HTML whitespace leaves around line breaks. */
const append = (out: string, next: string): string => {
    if (next === "") {
        return out;
    }

    const head = next.startsWith("\n") ? trimSpacesEnd(out) : out;

    return head + (head.endsWith("\n") ? trimSpacesStart(next) : next);
};

const styleOf = (element: Element): string => element.getAttribute("style") ?? "";

/** `**`, `*` or `~~` around inline content, with its outer spaces kept outside; nothing around content that spans lines. */
const wrap = (inner: string, marker: string): string => {
    const core = inner.trim();

    if (core === "" || inner.includes("\n")) {
        return inner;
    }

    return inner.slice(0, inner.indexOf(core)) + marker + core + marker + inner.slice(inner.indexOf(core) + core.length);
};

const indent = (text: string, prefix: string, first: string): string =>
    text
        .split("\n")
        .map((line: string, index: number) => {
            if (index === 0) {
                return first + line;
            }

            return line === "" ? "" : prefix + line;
        })
        .join("\n");

const languageOf = (pre: Element): string => {
    for (const element of [pre.querySelector("code"), pre, pre.parentElement, pre.parentElement?.parentElement]) {
        const match = LANGUAGE_CLASS.exec(element?.getAttribute("class") ?? "");

        if (match?.[1] && match[1] !== "source") {
            return match[1].toLowerCase();
        }
    }

    return "";
};

const inlineCode = (text: string): string => {
    const code = text.includes("\n") ? oneLine(text) : text;

    if (code.trim() === "") {
        return code;
    }

    const fence = "`".repeat(longestBacktickRun(code) + 1);
    const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";

    return fence + pad + code + pad + fence;
};

const safeHref = (element: Element): string | undefined => {
    const href = element.getAttribute("href")?.trim();

    if (!href) {
        return undefined;
    }

    try {
        const url = new URL(href);

        return LINK_PROTOCOLS.has(url.protocol) ? url.href.replaceAll("(", "%28").replaceAll(")", "%29").replaceAll(" ", "%20") : undefined;
    } catch {
        // A relative link means nothing outside its page.
        return undefined;
    }
};

const cellText = (cell: Element, context: Context): string =>
    oneLine(children(cell, { ...context, inTable: true }))
        .trim()
        .replaceAll("|", String.raw`\|`);

const table = (element: Element, context: Context): string => {
    const rows = [...element.querySelectorAll("tr")].filter((row: Element) => row.closest("table") === element);
    const cells = rows.map((row: Element) =>
        [...row.children].filter((cell: Element) => cell.tagName === "TD" || cell.tagName === "TH").map((cell: Element) => cellText(cell, context)),
    );
    const width = Math.max(0, ...cells.map((row: string[]) => row.length));

    if (width === 0) {
        return "";
    }

    const line = (row: string[]): string => `| ${Array.from({ length: width }, (_: unknown, index: number) => row[index] ?? "").join(" | ")} |`;
    const [head = [], ...body] = cells;

    return `\n\n${[line(head), `|${" --- |".repeat(width)}`, ...body.map((row: string[]) => line(row))].join("\n")}\n\n`;
};

const list = (element: Element, context: Context): string => {
    const ordered = element.tagName === "OL";
    let number = Number.parseInt(element.getAttribute("start") ?? "1", 10) || 1;
    const items: string[] = [];

    for (const item of element.children) {
        if (item.tagName !== "LI") {
            continue;
        }

        const marker = ordered ? `${number}. ` : "- ";
        // Google Docs keeps nested items in a flat list and marks their depth with aria-level.
        const ariaLevel = Number.parseInt(item.getAttribute("aria-level") ?? "1", 10) || 1;
        const level = Math.min(Math.max(ariaLevel, 1), 6);
        const body = children(item, context).replaceAll(BLANK_LINES, "\n\n").trim();

        number += 1;
        items.push(" ".repeat(4).repeat(level - 1) + indent(body, " ".repeat(marker.length), marker));
    }

    return `\n\n${items.join("\n")}\n\n`;
};

/** Word writes a list as paragraphs with `mso-list` styles and the bullet as hidden text. */
const wordListItem = (element: Element, inner: string): string | undefined => {
    const level = WORD_LIST_LEVEL.exec(styleOf(element));

    if (!level) {
        return undefined;
    }

    const bullet = ([...element.querySelectorAll("span")].find((span: Element) => WORD_LIST_BULLET.test(styleOf(span)))?.textContent ?? "").trim();
    const number = bullet.endsWith(")") ? `${bullet.slice(0, -1)}.` : bullet;
    const marker = WORD_ORDERED_MARKER.test(bullet) ? `${number} ` : "- ";

    return `\n${" ".repeat(4).repeat(Number(level[1]) - 1)}${marker}${inner.trim()}\n`;
};

const element = (node: Element, context: Context): string => {
    const tag = node.tagName.toUpperCase();
    const style = styleOf(node);

    if (SKIPPED.has(tag) || HIDDEN_STYLE.test(style) || node.hasAttribute("hidden")) {
        return "";
    }

    switch (tag) {
        case "A": {
            const text = children(node, context);
            const href = safeHref(node);

            if (!href || text.trim() === "" || text.includes("\n")) {
                return text;
            }

            const label = text.trim().replaceAll(/[[\]]/g, String.raw`\$&`);

            return label === href ? href : `[${label}](${href})`;
        }
        case "B":
        case "STRONG": {
            const inner = children(node, context);

            // Google Docs wraps the whole copy in `<b style="font-weight:normal">`.
            return NORMAL_WEIGHT.test(style) ? inner : wrap(inner, "**");
        }
        case "BLOCKQUOTE": {
            const inner = children(node, context).replaceAll(BLANK_LINES, "\n\n").trim();

            return `\n\n${inner
                .split("\n")
                .map((line: string) => (line === "" ? ">" : `> ${line}`))
                .join("\n")}\n\n`;
        }
        case "BR": {
            return context.inTable ? " " : "\n";
        }
        case "CODE":
        case "KBD":
        case "SAMP":
        case "TT": {
            return inlineCode(node.textContent ?? "");
        }
        case "DEL":
        case "S":
        case "STRIKE": {
            return wrap(children(node, context), "~~");
        }
        case "EM":
        case "I": {
            return wrap(children(node, context), "*");
        }
        case "HR": {
            return "\n\n---\n\n";
        }
        case "INPUT": {
            if (node.getAttribute("type") !== "checkbox") {
                return "";
            }

            return node.hasAttribute("checked") ? "[x] " : "[ ] ";
        }
        case "OL":
        case "UL": {
            return list(node, context);
        }
        case "PRE": {
            context.code.push(fenceCode(node.textContent ?? "", languageOf(node)));

            return `\n\n\0${context.code.length - 1}\0\n\n`;
        }
        case "TABLE": {
            return context.inTable ? "" : table(node, context);
        }
        default: {
            break;
        }
    }

    let inner = children(node, context);

    if (HEADING.test(tag)) {
        const text = oneLine(inner).trim();

        return text === "" ? "" : `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n`;
    }

    if (tag === "SPAN" || tag === "FONT") {
        inner = BOLD_STYLE.test(style) ? wrap(inner, "**") : inner;
        inner = ITALIC_STYLE.test(style) ? wrap(inner, "*") : inner;

        return STRIKE_STYLE.test(style) ? wrap(inner, "~~") : inner;
    }

    if (tag === "P") {
        const item = wordListItem(node, inner);

        if (item !== undefined) {
            return item;
        }
    }

    if (BLOCKS.has(tag)) {
        return `\n\n${inner.trim()}\n\n`;
    }

    return LINE_BLOCKS.has(tag) || tag === "LI" || tag === "TR" ? `\n${inner.trim()}\n` : inner;
};

function children(node: Node, context: Context): string {
    let out = "";

    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            out = append(out, (child.nodeValue ?? "").replaceAll("\0", "").replaceAll(/\s+/g, " "));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            out = append(out, element(child as Element, context));
        }
    }

    return out;
}

/** The Markdown for a clipboard `text/html` payload; empty when it holds no text. */
export const htmlToMarkdown = (html: string): string => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const context: Context = { code: [], inTable: false };

    return children(parsed.body, context)
        .split("\n")
        .map((line: string) => trimSpacesEnd(line))
        .join("\n")
        .replaceAll(BLANK_LINES, "\n\n")
        .trim()
        .replaceAll(PLACEHOLDER, (_: string, index: string) => context.code[Number(index)] ?? "");
};
