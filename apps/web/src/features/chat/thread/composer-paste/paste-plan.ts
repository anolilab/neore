/**
 * What the composer does with a text paste. Kept small: it is on the composer's eager path, and the HTML converter it
 * points to is loaded only when a paste needs it.
 */

/** Leave the paste to the editor, insert `text` as typed, or convert `html` to Markdown (`plain` if that fails). */
export type PastePlan = { html: string; kind: "html"; plain: string } | { kind: "default" } | { kind: "text"; text: string };

const URL_ONLY = /^https?:\/\/\S+$/i;
const LINK = /<a\s[^>]*href/i;
const LANGUAGE = /class=["']?[^"'>]*(?:language|lang|highlight)-/i;
// Formatting the Markdown can carry. A `<pre>` alone is not in it: terminals and code editors wrap their text in one.
const FORMATTING = [
    /<(?:h[1-6]|ul|ol|table|blockquote)[\s>]/i,
    /<(?:[bis]|strong|em|del|strike|code|kbd|math|img)[\s>]/i,
    LINK,
    /font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic/i,
    /text-decoration[\w-]*\s*:[^;"]*line-through/i,
];
// Paragraphs, lists, headings and tables are a document, even in a monospace block.
const STRUCTURE = /<(?:h[1-6]|ul|ol|table|blockquote|p)[\s>]/i;
// The first element that holds content: not the document, its head, or a comment.
const FIRST_ELEMENT = /<(?![!/]|(?:html|head|body|meta|title|style)\b)([a-z][\w-]*)(\s[^>]*)?>/i;
const MONOSPACE_FONT = /font-family\s*:[^;">]*(?:mono|consolas|menlo|courier)/i;
const MAX_CONVERTED_HTML = 1_000_000;
const BACKTICK_RUNS = /`+/g;
const ENTITY = /&(?:amp|gt|lt|nbsp|quot|#39);/g;
const ENTITIES: Record<string, string> = { "&#39;": "'", "&amp;": "&", "&gt;": ">", "&lt;": "<", "&nbsp;": " ", "&quot;": '"' };
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

/**
 * Whether clipboard HTML adds nothing to its `text/plain`: text in a span or div, or a code editor's or terminal's
 * monospace block (whose colours and bold keywords are not formatting). Regexes over the markup, so the converter is
 * never loaded for it.
 */
export const isPlainHtml = (html: string): boolean => {
    if (LANGUAGE.test(html)) {
        return false;
    }

    if (FORMATTING.every((pattern: RegExp) => !pattern.test(html))) {
        return true;
    }

    const [, tag = "", attributes = ""] = FIRST_ELEMENT.exec(html) ?? [];
    const monospaceRoot = tag.toLowerCase() === "pre" || (tag.toLowerCase() === "div" && MONOSPACE_FONT.test(attributes));

    return monospaceRoot && !STRUCTURE.test(html) && !LINK.test(html);
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

const markdownLink = (label: string, url: string): string =>
    `[${label.replaceAll(/[[\]\\]/g, String.raw`\$&`)}](${url.replaceAll("(", "%28").replaceAll(")", "%29")})`;

interface PasteOptions {
    /** Ctrl/Cmd+Shift+V: the text exactly as copied. */
    plainOnly: boolean;
    /** The composer text the paste replaces. */
    selectedText: string;
}

export const planPaste = (data: Pick<DataTransfer, "getData">, { plainOnly, selectedText }: PasteOptions): PastePlan => {
    const plain = data.getData("text/plain");

    if (plainOnly) {
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
    if (html.trim() === "" || html.includes("data-quote-chip")) {
        return { kind: "default" };
    }

    return plain !== "" && isPlainHtml(html) ? { kind: "text", text: plain } : { html, kind: "html", plain };
};

/** The text of HTML too big to parse, in one pass: every `<…>` dropped and the common entities decoded. */
const stripTags = (html: string): string => {
    const parts: string[] = [];
    let index = 0;

    while (index < html.length) {
        const open = html.indexOf("<", index);

        parts.push(html.slice(index, open === -1 ? html.length : open));

        const close = open === -1 ? -1 : html.indexOf(">", open);

        index = close === -1 ? html.length : close + 1;
    }

    return parts
        .join("")
        .replaceAll(ENTITY, (entity: string) => ENTITIES[entity] ?? entity)
        .trim();
};

/** The text a paste inserts: the Markdown for HTML, or `plain` when the converter cannot load (a deploy since the page opened) or finds no text. */
export const planText = async (plan: Exclude<PastePlan, { kind: "default" }>): Promise<string> => {
    if (plan.kind === "text") {
        return plan.text;
    }

    // A page this big becomes an attachment whatever its form; converting it would only hold up the tab.
    if (plan.html.length > MAX_CONVERTED_HTML) {
        return plan.plain === "" ? stripTags(plan.html) : plan.plain;
    }

    try {
        const { htmlToMarkdown } = await import("./html-to-markdown");

        return htmlToMarkdown(plan.html) || plan.plain;
    } catch {
        return plan.plain;
    }
};
