/**
 * What the composer does with a text paste. Kept small: it is on the composer's eager path, and the HTML converter it
 * points to is loaded only when a paste needs it.
 */

/** Leave the paste to the editor, insert `text` as typed, or convert `html` to Markdown (`plain` if that fails). */
export type PastePlan = { html: string; kind: "html"; plain: string } | { kind: "default" } | { kind: "text"; text: string };

const URL_ONLY = /^https?:\/\/\S+$/i;
// Repetitions are bounded and tags are found with indexOf: the clipboard HTML is untrusted, and a regex that rescans to
// the end from every `<` or `class=` would take quadratic time on a crafted copy.
const LINK_START = /<a\s/gi;
const DIV_START = /<div\s/gi;
const QUOTE_CHIP_ATTRIBUTE = "data-quote-chip";
const HREF = /href/i;
// HTML allows space around the `=`: `class = "language-js"` names a language too.
const LANGUAGE = /class\s{0,20}=\s{0,20}["']?[^"'>]{0,200}(?:language|lang|highlight)-/i;
// Formatting the Markdown can carry. A `<pre>` alone is not in it: terminals and code editors wrap their text in one.
const FORMATTING = [
    /<(?:h[1-6]|ul|ol|table|blockquote|hr)[\s/>]/i,
    // A task box outside a list: `<input>` has no closing tag, so its type is looked for within the tag only.
    /<input[^>]{0,200}checkbox/i,
    /<(?:[bis]|strong|em|del|strike|code|kbd|math|img)[\s>]/i,
    /font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic/i,
    /text-decoration[\w-]{0,20}\s*:[^;"]{0,100}line-through/i,
    // Word's list paragraphs: plain text keeps only their bullet characters and tabs.
    /mso-list\s{0,20}:/i,
];
// Paragraphs, lists, headings and tables are a document, even in a monospace block.
const STRUCTURE = /<(?:h[1-6]|ul|ol|table|blockquote|p)[\s>]/i;
// The first element that holds content: not the document, its head, or a comment.
const FIRST_ELEMENT = /<(?![!/]|(?:html|head|body|meta|title|style)\b)([a-z][\w-]*)(?=[\s>])/i;
const MONOSPACE_FONT = /font-family\s*:[^;">]{0,200}(?:mono|consolas|menlo|courier)/i;
const MAX_CONVERTED_HTML = 1_000_000;
const BACKTICK_RUNS = /`+/g;
// Bounded digit runs: the longest valid reference is `&#1114111;` or `&#x10FFFF;`.
const ENTITY = /&(?:amp|gt|lt|nbsp|quot|#\d{1,7}|#[Xx][\dA-Fa-f]{1,6});/g;
const ENTITIES: Record<string, string> = { "&amp;": "&", "&gt;": ">", "&lt;": "<", "&nbsp;": " ", "&quot;": '"' };

/** A named entity from ENTITIES or a decimal or hex character reference; one that names no character stays as written. */
const decodeEntity = (entity: string): string => {
    const named = ENTITIES[entity];

    if (named !== undefined) {
        return named;
    }

    const hex = entity[2] === "x" || entity[2] === "X";
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);

    return code > 0 && code <= 0x10_ff_ff && (code < 0xd8_00 || code > 0xdf_ff) ? String.fromCodePoint(code) : entity;
};
// Elements whose content is not text the page shows.
const RAW_TEXT = /<(script|style|noscript|template)[\s/>]/iy;
// Where each raw-text element ends: its name followed by a space, `/` or `>` (`</scripture>` is not `</script>`).
const RAW_TEXT_END: Record<string, RegExp> = {
    noscript: /<\/noscript(?=[\s/>]|$)/gi,
    script: /<\/script(?=[\s/>]|$)/gi,
    style: /<\/style(?=[\s/>]|$)/gi,
    template: /<\/template(?=[\s/>]|$)/gi,
};
// Tags whose text stands apart from its neighbours': on a line of its own, or a cell away.
const LINE_TAG = /<\/?(?:p|div|br|li|tr|h[1-6])[\s/>]/iy;
const CELL_TAG = /<t[dh][\s/>]/iy;
// What starts markup after a `<`; any other `<` is text, as in `2 < 3`.
const MARKUP_START = /[a-z/!?]/i;
const LINE_RUNS = /\n{2,}/g;
const LANGUAGE_UNSAFE = /[^\w#+.-]/g;
const VSCODE_LANGUAGES: Record<string, string> = { javascriptreact: "jsx", plaintext: "", shellscript: "bash", typescriptreact: "tsx" };

/** A loop, not `Math.max(...runs)`: a big paste has more runs than a call takes arguments. */
export const longestBacktickRun = (text: string): number => {
    let longest = 0;

    for (const [run] of text.matchAll(BACKTICK_RUNS)) {
        longest = Math.max(longest, run.length);
    }

    return longest;
};

/** `code` as a fenced block; the fence is longer than any backtick run inside. */
export const fenceCode = (code: string, language = ""): string => {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));

    let end = code.length;

    while (code[end - 1] === "\n") {
        end -= 1;
    }

    return `${fence}${language}\n${code.slice(0, end)}\n${fence}`;
};

// The whitespace HTML allows around an attribute's `=`.
const HTML_SPACE_CHAR = new Set([" ", "\t", "\n", "\f", "\r"]);

/**
 * The `>` that ends the tag opening at `open`, or -1: a `>` inside a quoted attribute value does not end it. Each
 * character is read once.
 */
const tagEnd = (html: string, open: number): number => {
    let index = open + 1;
    // Whether the last character that was not a space is `=`: a quote opens a value only there (`<p>don't` has no
    // attribute to skip), however much space HTML allows between the two.
    let afterEquals = false;

    while (index < html.length) {
        const char = html[index] ?? "";

        if (char === ">") {
            return index;
        }

        if ((char === '"' || char === "'") && afterEquals) {
            const closeQuote = html.indexOf(char, index + 1);

            if (closeQuote === -1) {
                return -1;
            }

            index = closeQuote;
            afterEquals = false;
        } else if (char === "=") {
            afterEquals = true;
        } else if (!HTML_SPACE_CHAR.has(char)) {
            afterEquals = false;
        }

        index += 1;
    }

    return -1;
};

/** Whether an `<a>` tag in `html` has an `href`. One pass: each tag's attributes are read once, up to its `>`. */
const hasLink = (html: string): boolean => {
    const starts = new RegExp(LINK_START);

    for (let start = starts.exec(html); start; start = starts.exec(html)) {
        // Its own `>`, not one inside a quoted value (`title="2 > 1"`).
        const end = tagEnd(html, start.index);

        // No end after this `<a`: none after any later one either.
        if (end === -1) {
            return false;
        }

        if (HREF.test(html.slice(start.index, end))) {
            return true;
        }

        starts.lastIndex = end;
    }

    return false;
};

/** `html` without its comments, in one pass with indexOf: a `<pre>` in a comment is not the first element shown. */
const withoutComments = (html: string): string => {
    const parts: string[] = [];
    let index = 0;

    for (let open = html.indexOf("<!--"); open !== -1; open = html.indexOf("<!--", index)) {
        parts.push(html.slice(index, open));

        const close = html.indexOf("-->", open + 4);

        if (close === -1) {
            return parts.join("");
        }

        index = close + 3;
    }

    parts.push(html.slice(index));

    return parts.join("");
};

/** Whether the tag from `open` to its `>` at `end` has the attribute `name`: as a name, not in a quoted value. */
const hasAttribute = (html: string, open: number, end: number, name: string): boolean => {
    let afterEquals = false;
    let afterSpace = false;

    let index = open + 1;

    while (index < end) {
        const char = html[index] ?? "";

        if ((char === '"' || char === "'") && afterEquals) {
            index = html.indexOf(char, index + 1);
            afterEquals = false;
            afterSpace = false;
        } else if (HTML_SPACE_CHAR.has(char)) {
            afterSpace = true;
        } else {
            const next = html[index + name.length] ?? "";

            if (
                afterSpace &&
                !afterEquals &&
                html.slice(index, index + name.length).toLowerCase() === name &&
                (next === "=" || next === "/" || next === ">" || HTML_SPACE_CHAR.has(next))
            ) {
                return true;
            }

            afterEquals = char === "=";
            afterSpace = false;
        }

        index += 1;
    }

    return false;
};

/** Whether `html` has a quote chip copied from a composer: a `<div>` shown (not in a comment) with `data-quote-chip`. */
const hasQuoteChip = (markup: string): boolean => {
    // Attribute names are not case-sensitive: `DATA-QUOTE-CHIP` names one too.
    if (!markup.toLowerCase().includes(QUOTE_CHIP_ATTRIBUTE)) {
        return false;
    }

    const html = withoutComments(markup);
    const starts = new RegExp(DIV_START);

    for (let start = starts.exec(html); start; start = starts.exec(html)) {
        const end = tagEnd(html, start.index);

        if (end === -1) {
            return false;
        }

        if (hasAttribute(html, start.index, end, QUOTE_CHIP_ATTRIBUTE)) {
            return true;
        }

        starts.lastIndex = end;
    }

    return false;
};

/** The first content element's tag name and attributes, as `<name …>` up to the first `>` after it. */
const firstElement = (markup: string): [tag: string, attributes: string] => {
    const html = withoutComments(markup);
    const match = FIRST_ELEMENT.exec(html);
    const end = match ? html.indexOf(">", match.index) : -1;

    return match && end !== -1 ? [match[1] ?? "", html.slice(match.index + match[0].length, end)] : ["", ""];
};

/**
 * Whether clipboard HTML adds nothing to its `text/plain`: text in a span or div, or a code editor's or terminal's
 * monospace block (whose colours and bold keywords are not formatting). Regexes over the markup, so the converter is
 * never loaded for it.
 */
export const isPlainHtml = (html: string): boolean => {
    if (LANGUAGE.test(html)) {
        return false;
    }

    const link = hasLink(html);

    if (!link && FORMATTING.every((pattern: RegExp) => !pattern.test(html))) {
        return true;
    }

    const [tag, attributes] = firstElement(html);
    const monospaceRoot = tag.toLowerCase() === "pre" || (tag.toLowerCase() === "div" && MONOSPACE_FONT.test(attributes));

    return monospaceRoot && !STRUCTURE.test(html) && !link;
};

const vscodeLanguage = (data: string): string | undefined => {
    try {
        const { mode } = JSON.parse(data) as { mode?: unknown };

        return typeof mode === "string" ? (VSCODE_LANGUAGES[mode] ?? mode.replaceAll(LANGUAGE_UNSAFE, "").slice(0, 30)) : "";
    } catch {
        return undefined;
    }
};

/** Past 500 characters or 10 lines a paste becomes a text attachment instead of composer text. */
export const isLongPaste = (text: string): boolean => text.length > 500 || text.split("\n").length > 10;

// Markdown lines that only parse at a line's start: a table row, a fence, a heading, a list item, a quote.
const BLOCK_LINE = /^(?:\||`{3}|~{3}|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/;
// A table or fence also takes a blank line before it, or the text before is read as part of it. So does a numbered list
// that does not start at 1: it cannot interrupt a paragraph.
const BLANK_LINE_BEFORE = /^(?:\||`{3}|~{3})/;
const ORDERED_START = /^(\d{1,9})[.)]\s/;
// Only a heading ends at its line: text after a table row, a list item or a quote continues it.
const HEADING = /^#{1,6}\s/;

/** The line breaks that keep `line` apart from the text on the same line before it or after it. */
const blockBreak = (line: string, side: "after" | "before"): string => {
    if (!BLOCK_LINE.test(line)) {
        return "";
    }

    if (side === "before") {
        const start = ORDERED_START.exec(line)?.[1];

        return BLANK_LINE_BEFORE.test(line) || (start !== undefined && Number(start) !== 1) ? "\n\n" : "\n";
    }

    return HEADING.test(line) ? "\n" : "\n\n";
};

/** The line breaks `markdown` takes after text it is appended to: one, or two before a block that needs a blank line. */
export const breaksBefore = (markdown: string): number => Math.max(blockBreak(markdown.split("\n", 1)[0] ?? "", "before").length, 1);

/** `markdown` with line breaks where its first or last line is a block that would join the text beside the caret. */
export const onOwnLines = (
    markdown: string,
    textBefore: boolean,
    textAfter: boolean,
    { lineAfter = false, lineBefore = false }: { lineAfter?: boolean; lineBefore?: boolean } = {},
): string => {
    const lines = markdown.split("\n");
    const first = lines[0] ?? "";
    const last = lines.at(-1) ?? "";
    let before = textBefore ? blockBreak(first, "before") : "";
    let after = textAfter ? blockBreak(last, "after") : "";

    // On a line of its own, with text on the line just above or below: the draft already has one break there, a block
    // that needs a blank line beside that text takes one more.
    if (!textBefore && lineBefore && blockBreak(first, "before") === "\n\n") {
        before = "\n";
    }

    if (!textAfter && lineAfter && blockBreak(last, "after") === "\n\n") {
        after = "\n";
    }

    return before + markdown + after;
};

const markdownLink = (label: string, url: string): string =>
    `[${label.replaceAll(/[[\]\\]/g, String.raw`\$&`)}](${url.replaceAll("(", "%28").replaceAll(")", "%29")})`;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether `textBefore` (the draft before the caret) leaves a code fence open. As in CommonMark, a fence closes only on a
 * run of its own character at least as long, with nothing after it; a backtick fence's info string has no backticks.
 */
export const inOpenFence = (textBefore: string): boolean => {
    let open = "";

    for (const line of textBefore.split("\n")) {
        const [fence = "", run = ""] = FENCE_LINE.exec(line) ?? [];

        if (run === "") {
            continue;
        }

        const rest = line.slice(fence.length);

        if (open === "") {
            open = run[0] === "`" && rest.includes("`") ? "" : run;
        } else if (run[0] === open[0] && run.length >= open.length && rest.trim() === "") {
            open = "";
        }
    }

    return open !== "";
};

interface PasteOptions {
    /** The caret is in a code block the person typed: what is pasted is code, never Markdown. */
    inFence?: boolean;
    /** Ctrl/Cmd+Shift+V: the text exactly as copied. */
    plainOnly: boolean;
    /** The composer text the paste replaces. */
    selectedText: string;
}

export const planPaste = (data: Pick<DataTransfer, "getData">, { inFence = false, plainOnly, selectedText }: PasteOptions): PastePlan => {
    const plain = data.getData("text/plain");

    if (plainOnly || inFence) {
        // Without text/plain the editor would paste the HTML with its formatting; a plain paste then inserts nothing.
        return plain === "" && data.getData("text/html").trim() === "" ? { kind: "default" } : { kind: "text", text: plain };
    }

    const url = plain.trim();

    // A URL pasted over a URL replaces it.
    if (selectedText.trim() !== "" && !selectedText.includes("\n") && URL_ONLY.test(url) && !URL_ONLY.test(selectedText.trim())) {
        return { kind: "text", text: markdownLink(selectedText, url) };
    }

    const vscode = data.getData("vscode-editor-data");

    // A copy that is long once fenced becomes an attachment, which holds the code as copied, without fence lines.
    if (vscode !== "" && plain.trim().includes("\n")) {
        const language = vscodeLanguage(vscode);
        const fenced = language === undefined ? "" : fenceCode(plain, language);

        if (fenced !== "" && !isLongPaste(fenced)) {
            return { kind: "text", text: fenced };
        }
    }

    const html = data.getData("text/html");

    // A quote chip copied from a composer: the editor rebuilds it from its HTML.
    if (html.trim() === "" || hasQuoteChip(html)) {
        return { kind: "default" };
    }

    // HTML past the cap is never converted (planText), so it need not be checked.
    return plain !== "" && html.length <= MAX_CONVERTED_HTML && isPlainHtml(html) ? { kind: "text", text: plain } : { html, kind: "html", plain };
};

/**
 * The text of HTML too big to parse, in one pass: every `<…>` and script, style, noscript and template dropped, a line
 * break for a paragraph, div, line, list item, row or heading tag and a space for a cell, the common entities decoded.
 */
const stripTags = (html: string): string => {
    const parts: string[] = [];
    let index = 0;

    while (index < html.length) {
        const open = html.indexOf("<", index);

        if (open === -1) {
            parts.push(html.slice(index));
            break;
        }

        parts.push(html.slice(index, open));

        if (!MARKUP_START.test(html[open + 1] ?? "")) {
            parts.push("<");
            index = open + 1;
            continue;
        }

        LINE_TAG.lastIndex = open;
        CELL_TAG.lastIndex = open;

        if (LINE_TAG.test(html)) {
            parts.push("\n");
        } else if (CELL_TAG.test(html)) {
            parts.push(" ");
        }

        RAW_TEXT.lastIndex = open;

        // A script's or style's text runs to its end tag, or to the end.
        const raw = RAW_TEXT.exec(html);
        let from = open;

        if (raw) {
            const end = RAW_TEXT_END[(raw[1] ?? "").toLowerCase()];

            if (end) {
                end.lastIndex = RAW_TEXT.lastIndex;
                from = end.exec(html)?.index ?? html.length;
            } else {
                from = html.length;
            }
        }

        // A comment ends at `-->`, a tag at its first `>` outside a quoted value.
        const [close, closeLength] = html.startsWith("<!--", from) ? [html.indexOf("-->", from + 4), 3] : [tagEnd(html, from), 1];

        index = close === -1 ? html.length : close + closeLength;
    }

    return parts
        .join("")
        .replaceAll(ENTITY, (entity: string) => decodeEntity(entity))
        .replaceAll(LINE_RUNS, "\n")
        .trim();
};

/** The text a paste inserts: the Markdown for HTML, or `plain` when the converter cannot load (a deploy since the page opened) or finds no text. */
export const planText = async (plan: Exclude<PastePlan, { kind: "default" }>): Promise<string> => {
    if (plan.kind === "text") {
        return plan.text;
    }

    // A page this big becomes an attachment whatever its form; converting it would only hold up the tab.
    if (plan.html.length > MAX_CONVERTED_HTML) {
        return plan.plain || stripTags(plan.html);
    }

    try {
        const { htmlToMarkdown } = await import("./html-to-markdown");

        return htmlToMarkdown(plan.html) || plan.plain;
    } catch {
        // Also HTML nested too deep to convert.
        return plan.plain || stripTags(plan.html);
    }
};
