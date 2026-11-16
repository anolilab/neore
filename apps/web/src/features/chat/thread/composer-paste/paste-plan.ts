/**
 * What the composer does with a text paste. Kept small: it is on the composer's eager path, and the HTML converter it
 * points to is loaded only when a paste needs it.
 */
import { reportCaughtError } from "@/lib/analytics/track";

/**
 * Leave the paste to the editor, insert `text` as typed (`markdown` when the plan wrote Markdown into it), or convert
 * `html` to Markdown (`plain` if that fails); with `textOnly`, to its visible text only.
 */
export type PastePlan =
    | { html: string; kind: "html"; plain: string; textOnly?: boolean }
    | { kind: "default" }
    | { kind: "text"; markdown?: boolean; text: string };

/** What a paste inserts, and whether it is Markdown the plan wrote, whose blocks are kept off the text beside the caret; not text as copied. */
export interface PastedText {
    markdown: boolean;
    text: string;
}

const URL_ONLY = /^https?:\/\/\S+$/i;
// Repetitions are bounded and tags are found with indexOf: the clipboard HTML is untrusted, and a regex that rescans to
// the end from every `<` or `class=` would take quadratic time on a crafted copy.
const LINK_START = /<a\s/gi;
const DIV_START = /<div\s/gi;
// A tag start: `<` and a name, or `</` and one.
const TAG_START = /<\/?[a-z]/iy;
const DIV_TAG_NAME = /^<(\/?)div[\s/>]/i;
const QUOTE_CHIP_ATTRIBUTE = "data-quote-chip";
// HTML allows space around the `=`: `class = "language-js"` names a language too. LANGUAGE finds a candidate anywhere;
// LANGUAGE_VALUE reads the value after a `class` attribute's name, inside its quotes.
const LANGUAGE = /class\s{0,20}=\s{0,20}["']?[^"'>]{0,200}(?:language|lang|highlight)-/i;
const LANGUAGE_VALUE = /\s{0,20}=\s{0,20}(?:"[^"]{0,200}|'[^']{0,200}|[^\s"'>]{0,200})(?:language|lang|highlight)-/iy;
// Formatting the Markdown can carry. A `<pre>` alone is not in it: terminals and code editors wrap their text in one.
const FORMATTING = [
    /<(?:h[1-6]|ul|ol|table|blockquote|hr)[\s/>]/i,
    // A task box outside a list: `<input>` has no closing tag, so its type is looked for within the tag only.
    /<input[^>]{0,200}checkbox/i,
    /<(?:[bis]|strong|em|del|strike|code|kbd|samp|tt|sup|sub|math|img)[\s>]/i,
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
// Named references are bounded: the longest HTML name has 31 characters (`&CounterClockwiseContourIntegral;`).
const ENTITY = /&(?:[a-z][a-z\d]{1,31}|#\d{1,7}|#x[\da-f]{1,6});/gi;
const ENTITIES: Record<string, string> = { "&amp;": "&", "&gt;": ">", "&lt;": "<", "&nbsp;": " ", "&quot;": '"' };

/** A named entity from ENTITIES or a decimal or hex character reference; one that names no character stays as written. */
// Named references decoded once each: the page has a few kinds, used many times.
const decodedNames = new Map<string, string>();

/** A named reference as the browser reads it: set as a textarea's content, which holds text only and runs nothing. */
const decodeName = (entity: string): string => {
    const known = decodedNames.get(entity);

    if (known !== undefined) {
        return known;
    }

    if (typeof document === "undefined" || decodedNames.size >= 2000) {
        return entity;
    }

    const textarea = document.createElement("textarea");

    textarea.innerHTML = entity;
    decodedNames.set(entity, textarea.value);

    return textarea.value;
};

const decodeEntity = (entity: string): string => {
    const named = ENTITIES[entity];

    if (named !== undefined) {
        return named;
    }

    if (entity[1] !== "#") {
        return decodeName(entity);
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
const LINE_TAG = /<\/?(?:p|div|li|tr|h[1-6])[\s/>]/iy;
const BREAK_TAG = /<\/?br[\s/>]/iy;
const CELL_TAG = /<t[dh][\s/>]/iy;
// What starts markup after a `<`; any other `<` is text, as in `2 < 3`.
const MARKUP_START = /[a-z/!?]/i;
const LINE_RUNS = /\n{2,}/g;
const SOURCE_BREAK = /\r\n?/g;
// A `<br>` (marked `\r` while the text is built) that ends a line: the block's own end.
const LINE_END_BREAK = /\r(?=\n)/g;
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

/**
 * Whether the tag between `open` and `end` has an `href` attribute: a name of its own, not `data-href` and not text inside
 * a quoted value. One pass over the tag, values skipped as `tagEnd` does.
 */
const hasHrefAttribute = (html: string, open: number, end: number): boolean => {
    let afterEquals = false;
    let index = open + 1;

    while (index < end) {
        const char = html[index] ?? "";

        if ((char === '"' || char === "'") && afterEquals) {
            const closeQuote = html.indexOf(char, index + 1);

            if (closeQuote === -1 || closeQuote > end) {
                return false;
            }

            index = closeQuote;
            afterEquals = false;
        } else if (char === "=") {
            afterEquals = true;
        } else if (HTML_SPACE_CHAR.has(char)) {
            const name = html.slice(index + 1, index + 5).toLowerCase();
            const after = html[index + 5] ?? "";

            if (name === "href" && (after === "=" || after === ">" || after === "/" || HTML_SPACE_CHAR.has(after))) {
                return true;
            }
        } else {
            afterEquals = false;
        }

        index += 1;
    }

    return false;
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

        if (hasHrefAttribute(html, start.index, end)) {
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

/** Where the tag from `open` to its `>` at `end` has the attribute `name`, or -1: as a name, not in a quoted value. */
const attributeAt = (html: string, open: number, end: number, name: string): number => {
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
                return index;
            }

            afterEquals = char === "=";
            afterSpace = false;
        }

        index += 1;
    }

    return -1;
};

/**
 * Whether a tag in `html` has a class naming a language: not text or another attribute's value that only reads like one.
 * Tag by tag, each read once to its own `>`.
 */
const hasLanguageClass = (markup: string): boolean => {
    if (!LANGUAGE.test(markup)) {
        return false;
    }

    const html = withoutComments(markup);
    const tagStart = new RegExp(TAG_START);
    const value = new RegExp(LANGUAGE_VALUE);

    for (let index = html.indexOf("<"); index !== -1;) {
        tagStart.lastIndex = index;

        if (tagStart.test(html)) {
            const close = tagEnd(html, index);

            if (close === -1) {
                return false;
            }

            const name = attributeAt(html, index, close, "class");

            value.lastIndex = name + 5;

            if (name !== -1 && value.test(html)) {
                return true;
            }

            index = html.indexOf("<", close + 1);
        } else {
            // A `<` not opening a tag (`1 < 2`) is text.
            index = html.indexOf("<", index + 1);
        }
    }

    return false;
};

/**
 * Where the `<div>` whose start tag ends at `end` closes: after its own `</div>`, nested divs counted, or the end of
 * `html`. Tag by tag, each read once to its own `>`: a `</div>` inside a quoted attribute value is not one.
 */
const divEnd = (html: string, end: number): number => {
    const tagStart = new RegExp(TAG_START);
    let depth = 1;
    let index = html.indexOf("<", end);

    while (index !== -1) {
        tagStart.lastIndex = index;

        // A `<` not opening a tag (`1 < 2`) is text.
        if (!tagStart.test(html)) {
            index = html.indexOf("<", index + 1);
            continue;
        }

        const close = tagEnd(html, index);

        if (close === -1) {
            return html.length;
        }

        const tag = DIV_TAG_NAME.exec(html.slice(index, Math.min(close + 1, index + 6)));

        if (tag) {
            depth += tag[1] === "/" ? -1 : 1;

            if (depth === 0) {
                return close + 1;
            }
        }

        index = html.indexOf("<", close + 1);
    }

    return html.length;
};

/**
 * `html` without the quote chips copied from a composer (a `<div>` shown, not in a comment, with `data-quote-chip`), and
 * whether it had one. One pass: each div start is read once, and a chip's end is looked for from where it starts.
 */
const splitQuoteChips = (markup: string): { chips: boolean; rest: string } => {
    // Attribute names are not case-sensitive: `DATA-QUOTE-CHIP` names one too.
    if (!markup.toLowerCase().includes(QUOTE_CHIP_ATTRIBUTE)) {
        return { chips: false, rest: markup };
    }

    const html = withoutComments(markup);
    const starts = new RegExp(DIV_START);
    const rest: string[] = [];
    let kept = 0;

    for (let start = starts.exec(html); start; start = starts.exec(html)) {
        const end = tagEnd(html, start.index);

        if (end === -1) {
            break;
        }

        if (attributeAt(html, start.index, end, QUOTE_CHIP_ATTRIBUTE) === -1) {
            starts.lastIndex = end;
        } else {
            rest.push(html.slice(kept, start.index));
            kept = divEnd(html, end);
            starts.lastIndex = kept;
        }
    }

    return kept === 0 ? { chips: false, rest: markup } : { chips: true, rest: rest.join("") + html.slice(kept) };
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
    if (hasLanguageClass(html)) {
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
const BLOCK_LINE = /^(?:\||`{3}|~{3}|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|---$)/;
// A table or fence also takes a blank line before it, or the text before is read as part of it; a rule too, or the text
// before becomes a heading. So does a numbered list that does not start at 1: it cannot interrupt a paragraph.
const BLANK_LINE_BEFORE = /^(?:\||`{3}|~{3}|---$)/;
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
    // A backslash is encoded too: left as it is, one at the end would escape the link's closing parenthesis.
    `[${label.replaceAll(/[[\]\\]/g, String.raw`\$&`)}](${url.replaceAll("\\", "%5C").replaceAll("(", "%28").replaceAll(")", "%29")})`;

// Quote and list markers before a line's content, so a fence in a quote or list item counts.
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-+*][ \t]|\d{1,9}[.)][ \t]))*/;
// At most three spaces before it: four or more make the line indented code, not a fence.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether `textBefore` (the draft before the caret) leaves a code fence open. As in CommonMark, a fence closes only on a
 * run of its own character at least as long, with nothing after it; a backtick fence's info string has no backticks.
 * Quote and list prefixes are skipped, not matched up: a draft is short, and a wrong guess only pastes text as copied.
 */
export const inOpenFence = (textBefore: string): boolean => {
    let open = "";

    for (const fullLine of textBefore.split("\n")) {
        const line = fullLine.slice(CONTAINER_PREFIX.exec(fullLine)?.[0].length ?? 0);
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

/**
 * The text of HTML too big to parse, in one pass: every `<…>` and script, style, noscript and template dropped, a line
 * break for a paragraph, div, list item, row or heading tag and a space for a cell, the common entities decoded. Block
 * breaks in a row are one, but each `<br>` is a line of its own, so `A<br><br>B` keeps its blank line; a `<br>` that
 * ends a block is that block's end.
 */
const stripTags = (html: string): string => {
    const parts: string[] = [];
    let index = 0;

    while (index < html.length) {
        const open = html.indexOf("<", index);

        if (open === -1) {
            parts.push(html.slice(index).replaceAll(SOURCE_BREAK, "\n"));
            break;
        }

        parts.push(html.slice(index, open).replaceAll(SOURCE_BREAK, "\n"));

        if (!MARKUP_START.test(html[open + 1] ?? "")) {
            parts.push("<");
            index = open + 1;
            continue;
        }

        LINE_TAG.lastIndex = open;
        BREAK_TAG.lastIndex = open;
        CELL_TAG.lastIndex = open;

        if (LINE_TAG.test(html)) {
            parts.push("\n");
        } else if (BREAK_TAG.test(html)) {
            parts.push("\r");
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
        .replaceAll(LINE_END_BREAK, "")
        .replaceAll("\r", "\n")
        .trim();
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
        const html = data.getData("text/html");

        if (plain === "" && html.trim() === "") {
            return { kind: "default" };
        }

        // text/plain exactly as copied; an HTML-only copy (in a code fence, or with the plain-paste shortcut) goes in as its
        // visible text, no Markdown added: read by the converter, which knows what the page hides, unless it is too big to parse.
        if (plain !== "") {
            return { kind: "text", text: plain };
        }

        return html.length > MAX_CONVERTED_HTML ? { kind: "text", text: stripTags(html) } : { html, kind: "html", plain: "", textOnly: true };
    }

    const url = plain.trim();

    // A URL pasted over a URL replaces it.
    if (selectedText.trim() !== "" && !selectedText.includes("\n") && URL_ONLY.test(url) && !URL_ONLY.test(selectedText.trim())) {
        // The spaces a double-click takes along stay outside the link, as for a pasted `<a>`.
        const label = selectedText.trim();
        const start = selectedText.indexOf(label);

        return {
            kind: "text",
            markdown: true,
            text: selectedText.slice(0, start) + markdownLink(label, url) + selectedText.slice(start + label.length),
        };
    }

    const vscode = data.getData("vscode-editor-data");

    // A copy that is long once fenced becomes an attachment, which holds the code as copied, without fence lines.
    if (vscode !== "" && plain.trim().includes("\n")) {
        const language = vscodeLanguage(vscode);
        const fenced = language === undefined ? "" : fenceCode(plain, language);

        if (fenced !== "" && !isLongPaste(fenced)) {
            return { kind: "text", markdown: true, text: fenced };
        }
    }

    const html = data.getData("text/html");

    if (html.trim() === "") {
        return { kind: "default" };
    }

    const { chips, rest } = splitQuoteChips(html);

    // A quote chip copied from a composer: the editor rebuilds it from its HTML, while the text beside it is plain. Beside
    // formatting the whole paste is converted, the chip to the quoted lines it stands for in the draft.
    if (chips) {
        return isPlainHtml(rest) ? { kind: "default" } : { html, kind: "html", plain };
    }

    // HTML past the cap is never converted (planText), so it need not be checked. Plain HTML with no text/plain goes in as
    // its visible text, as the converter would fence a monospace block.
    if (html.length > MAX_CONVERTED_HTML || !isPlainHtml(html)) {
        return { html, kind: "html", plain };
    }

    return plain === "" ? { html, kind: "html", plain, textOnly: true } : { kind: "text", text: plain };
};

const asCopied = (plan: { html: string; plain: string }): PastedText => {
    return { markdown: false, text: plan.plain || stripTags(plan.html) };
};

/**
 * The text a paste inserts: the Markdown for HTML, or `plain` as copied when the converter cannot load (a deploy since
 * the page opened), refuses the HTML or finds no text.
 */
export const planText = async (plan: Exclude<PastePlan, { kind: "default" }>): Promise<PastedText> => {
    if (plan.kind === "text") {
        return { markdown: plan.markdown === true, text: plan.text };
    }

    // A page this big becomes an attachment whatever its form; converting it would only hold up the tab.
    if (plan.html.length > MAX_CONVERTED_HTML) {
        return asCopied(plan);
    }

    let converter: typeof import("./html-to-markdown");

    try {
        converter = await import("./html-to-markdown");
    } catch {
        return asCopied(plan);
    }

    try {
        if (plan.textOnly) {
            return { markdown: false, text: converter.visibleText(plan.html) };
        }

        const markdown = converter.htmlToMarkdown(plan.html);

        return markdown === "" ? { markdown: false, text: plan.plain } : { markdown: true, text: markdown };
    } catch (error) {
        // A RangeError is the converter refusing HTML nested too deep or past its work budgets. Anything else is a bug in it,
        // reported without the clipboard's content.
        if (!(error instanceof RangeError)) {
            reportCaughtError(error, { feature: "composer-paste" });
        }

        return asCopied(plan);
    }
};
