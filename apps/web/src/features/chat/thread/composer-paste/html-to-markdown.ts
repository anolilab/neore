/**
 * Clipboard HTML → Markdown for the composer. Loaded with `import()` only when a paste carries HTML.
 *
 * The HTML is untrusted: it is parsed with `DOMParser` into an inert document (no scripts run, nothing loads), only its
 * text is read, and the result goes into the editor as text, never as HTML.
 */

/* eslint-disable @typescript-eslint/no-use-before-define -- children() and element() walk the tree by calling each other */

import { fenceCode, longestBacktickRun } from "./paste-plan";

const SKIPPED = new Set([
    // A formula's source in another notation: MathML does not show it.
    "ANNOTATION",
    "ANNOTATION-XML",
    "AUDIO",
    "BUTTON",
    "CANVAS",
    "EMBED",
    "HEAD",
    "IFRAME",
    "LINK",
    "META",
    "NOSCRIPT",
    "OBJECT",
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
const BOLD_WEIGHT = /^(?:bold|bolder|[6-9]00)$/;
const NORMAL_WEIGHT = /^(?:normal|lighter|[1-4]00)$/;
const STRIKE_STYLE = /text-decoration[\w-]{0,20}\s*:[^;]{0,200}line-through/i;
const HIDDEN_CLASS = /(?:^|\s)(?:sr-only|visually-?hidden)(?:\s|$)/i;
const EMOJI_NAME = /^:[\w+-]{1,40}:$/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Only emoji: pictographs and the joiners, modifiers, selectors and flag letters that build them.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const MATH_CLASS = /math/i;
const WORD_LIST_LEVEL = /mso-list\s*:[^;]{0,200}level(\d)/i;
// Up to nine digits, the most a Markdown marker takes: a list numbered past 9999 keeps its numbers.
const WORD_ORDERED_MARKER = /^\d{1,9}[.)]$/;
// A letter or roman numeral Word numbers a level with (`a.`, `iv)`): Markdown has no such marker, so it is kept as text.
const WORD_LETTERED_MARKER = /^[a-z]{1,9}[.)]$/i;
const IMPORTANT = /!\s{0,20}important\s{0,20}$/i;
const HEADING = /^H[1-6]$/;
const BLANK_LINES = /\n{3,}/g;
// The whitespace HTML collapses: ASCII only. `\s` would also take the non-breaking spaces Word and Google Docs indent with.
const HTML_SPACE = /[\t\n\f\r ]+/g;
// After collapsing, an edge holds at most one plain space.
const EDGE_SPACE = /^ | $/g;
const PLACEHOLDER = /\0(\d+)\0/g;
// Around text that restores normal weight inside bold: the bold around it is closed for it (`wrap`). Taken out of the
// page's own text, with the placeholders' NUL, so only the converter writes them.
const NORMAL_START = "\u{1}";
const NORMAL_END = "\u{2}";
const JOINER = "\u{200D}";
// What a ZWJ emoji sequence joins: a pictograph, its emoji selector or a skin tone.
const EMOJI_EDGE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]$/u;
// After blank-line runs are collapsed, an edge holds at most two line breaks.
const LEADING_NEWLINE = /^\n{1,2}/;
const TRAILING_NEWLINE = /\n{1,2}$/;
// Characters Unicode has raised or lowered forms of, so `E=mc<sup>2</sup>` stays `E=mc²` in plain Markdown.
const SCRIPT_FROM = "0123456789+-\u{2212}=()";
const SUPERSCRIPT = new Map([...`${SCRIPT_FROM}ni`].map((char: string, index: number) => [char, [..."⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ"][index] ?? char]));
const SUBSCRIPT = new Map([...SCRIPT_FROM].map((char: string, index: number) => [char, [..."₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎"][index] ?? char]));
/** Grid cells all tables of a paste may fill: spans multiply a cell, and past this a table is pasted as its text. */
const MAX_TABLE_CELLS = 100_000;
/** Characters quotes and list items may re-indent in all: each re-indents all it holds, so deep nesting is quadratic. */
const MAX_INDENT_WORK = 20_000_000;
// Characters bold, italic and strike may rebuild line by line: a real paste wraps its text a few times, a crafted one
// nests hundreds of elements around the same lines.
const MAX_WRAP_WORK = 2_000_000;
/** Elements deep the walk goes before the paste falls back to its plain text, well before the stack runs out. */
const MAX_DEPTH = 500;
/** Elements the walk reads as code or a formula: a paragraph in one is never a Word list item. */
const NOT_WALKED = new Set(["CODE", "KBD", "MATH", "PRE", "SAMP", "TT"]);

interface Context {
    /** Bold elements around the node: text set back to normal weight inside one is marked to stay out of its `**`. */
    bold: number;
    /** Fenced code blocks and links in table cells, put back at the end so clean-up and cell escaping never touch them. */
    code: string[];
    depth: number;
    /** Characters quotes and list items may still re-indent. */
    indentWork: number;
    /** Inside a list item: a list there follows the item's text on the next line, so the outer list stays tight. */
    inListItem?: boolean;
    inTable: boolean;
    /** Grid cells the tables still left to convert may fill. */
    tableCells: number;
    /** The shallowest Word list level in the paste: a copy that starts at a nested item starts at the left edge. */
    wordTopLevel: number;
    /** Characters formatting may still rebuild (`wrap`). */
    wrapWork: number;
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

const styleOf = (element: Element): string => element.getAttribute("style") ?? "";

/** Whether a declaration in `style` sets `property` to `value`: not the same words inside another value, such as a URL. */
const declares = (style: string, property: string, value: string): boolean =>
    style.split(";").some((declaration: string) => {
        const colon = declaration.indexOf(":");

        return (
            colon !== -1 &&
            declaration.slice(0, colon).trim().toLowerCase() === property &&
            declaration
                .slice(colon + 1)
                .replace(IMPORTANT, "")
                .trim()
                .toLowerCase() === value
        );
    });

/**
 * The value `style` gives `property`, as CSS reads it: the last declaration wins, unless an earlier one is `!important`
 * and the later one is not. Lower case, without `!important`; empty when it sets none.
 */
const declared = (style: string, property: string): string => {
    let value = "";
    let important = false;

    for (const declaration of style.split(";")) {
        const colon = declaration.indexOf(":");

        if (colon === -1 || declaration.slice(0, colon).trim().toLowerCase() !== property) {
            continue;
        }

        const raw = declaration.slice(colon + 1);
        const isImportant = IMPORTANT.test(raw);

        if (isImportant || !important) {
            value = raw.replace(IMPORTANT, "").trim().toLowerCase();
            important = isImportant;
        }
    }

    return value;
};

const isBoldStyle = (style: string): boolean => BOLD_WEIGHT.test(declared(style, "font-weight"));
const isNormalWeight = (style: string): boolean => NORMAL_WEIGHT.test(declared(style, "font-weight"));
const isItalicStyle = (style: string): boolean => ["italic", "oblique"].includes(declared(style, "font-style"));

/** Word's list bullet, written as text the page does not show. */
const isWordBullet = (element: Element): boolean => element.tagName === "SPAN" && declares(styleOf(element), "mso-list", "ignore");

/** Whether the page leaves `element` out of what it shows (or it is not text at all). */
const isHidden = (element: Element): boolean =>
    SKIPPED.has(element.tagName.toUpperCase()) ||
    declared(styleOf(element), "display") === "none" ||
    declared(styleOf(element), "visibility") === "hidden" ||
    declares(styleOf(element), "mso-list", "ignore") ||
    HIDDEN_CLASS.test(element.getAttribute("class") ?? "") ||
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true";

/** Elements a page shows on lines of their own besides the blocks: read only as page text, as code rarely holds them. */
const PAGE_LINES = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "OL", "PRE", "TABLE", "TR", "UL"]);
const CELLS = new Set(["TD", "TH"]);

/**
 * The text of code as shown, whitespace kept: no hidden parts, and a line per `<br>` and per line block. With `page`, the
 * text of a page instead: HTML whitespace collapsed outside `<pre>`, a line per row, list item and heading, a space
 * between cells.
 */
const codeText = (node: Node, page = false): string => {
    // One list of parts for the whole block, nested elements included, with the last character tracked: joining per element
    // rebuilt a text run once per element around it, and `endsWith` on a string built by `+=` flattens all of it.
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
                const text = (child.nodeValue ?? "").replaceAll("\0", "").replaceAll(NORMAL_START, "").replaceAll(NORMAL_END, "");

                if (!page || inPre) {
                    push(text);
                } else {
                    const collapsed = text.replaceAll(HTML_SPACE, " ");

                    // Collapsed space at the start of a line is not shown.
                    push(parts.length === 0 || endsWithNewline || lineEnded ? trimSpacesStart(collapsed) : collapsed);
                }
            } else if (child.nodeType === Node.ELEMENT_NODE && !isHidden(child as Element)) {
                const { tagName } = child as Element;
                const isLine = BLOCKS.has(tagName) || LINE_BLOCKS.has(tagName) || (page && PAGE_LINES.has(tagName));

                if (page && CELLS.has(tagName) && parts.length > 0 && !endsWithNewline && !lineEnded) {
                    push(" ");
                }

                if (isLine && parts.length > 0 && !endsWithNewline) {
                    // The one break between the two lines: the one the line before asked for is this one.
                    lineEnded = false;
                    push("\n");
                }

                if (tagName === "BR") {
                    push("\n");
                } else if (tagName === "DETAILS" && !(child as Element).hasAttribute("open")) {
                    // A closed one shows its summary alone.
                    const summary = [...(child as Element).children].find((nested: Element) => nested.tagName === "SUMMARY");

                    if (summary && !isHidden(summary)) {
                        walk(summary, depth + 1, inPre);
                    }
                } else {
                    walk(child, depth + 1, inPre || tagName === "PRE");
                }

                lineEnded ||= isLine;
            }
        }
    };

    walk(node, 0, false);

    return parts.join("");
};

/** `marker` around one line's text, with its outer spaces kept outside. */
const wrapLine = (line: string, marker: string): string => {
    const core = line.trim();

    if (core === "") {
        return line;
    }

    const start = line.indexOf(core);

    return line.slice(0, start) + marker + core + marker + line.slice(start + core.length);
};

/** The text at the start of `node` (its first descendant's), or "": one step per level, so each element is read for its siblings only. */
const firstText = (node: Node | null): string => {
    let current = node;

    while (current?.nodeType === Node.ELEMENT_NODE) {
        current = current.firstChild;
    }

    return current?.nodeType === Node.TEXT_NODE ? (current.nodeValue ?? "") : "";
};

const lastText = (node: Node | null): string => {
    let current = node;

    while (current?.nodeType === Node.ELEMENT_NODE) {
        current = current.lastChild;
    }

    return current?.nodeType === Node.TEXT_NODE ? (current.nodeValue ?? "") : "";
};

/**
 * `tex` as inline math. Like a code span, math ends at the first `$` run as long as the one it opened with, so the
 * delimiter is one `$` longer than any run inside, with a space against a `$` at either edge: a `$` in the formula
 * cannot close it early and turn the rest of its source into Markdown.
 */
const inlineMath = (tex: string): string => {
    let longest = 0;
    let run = 0;

    for (const character of tex) {
        run = character === "$" ? run + 1 : 0;
        longest = Math.max(longest, run);
    }

    const fence = "$".repeat(longest + 1);
    const pad = tex.startsWith("$") || tex.endsWith("$") ? " " : "";

    return `${fence}${pad}${tex}${pad}${fence}`;
};

const firstCodePoint = (text: string): string => String.fromCodePoint(text.codePointAt(0) ?? 0);

const lastCodePoint = (text: string): string => {
    const low = text.codePointAt(text.length - 1) ?? 0;

    return text.slice(low >= 0xdc_00 && low <= 0xdf_ff ? -2 : -1);
};

/**
 * Whether the element's edge falls inside a ZWJ emoji sequence (`<b>👩</b>‍👩`). A marker there parts the joiner from an
 * emoji, so hidden-text stripping would drop it; bold or italics show nothing on an emoji anyway, so it is left unmarked.
 */
const splitsEmoji = (node: Element, inner: string): boolean => {
    const core = inner.trim();

    if (core === "") {
        return false;
    }

    if (core.startsWith(JOINER) || core.endsWith(JOINER)) {
        return true;
    }

    return (
        (EMOJI_EDGE.test(lastCodePoint(inner)) && firstText(node.nextSibling).startsWith(JOINER)) ||
        (EMOJI_EDGE.test(firstCodePoint(inner)) && lastText(node.previousSibling).endsWith(JOINER))
    );
};

/** Text set back to normal weight inside bold, marked so the bold around it leaves it out (`wrap`). */
const unbold = (inner: string, context: Context): string => {
    if (context.bold === 0 || inner.trim() === "") {
        return inner;
    }

    context.wrapWork -= inner.length;

    // Marks inside it are not needed: all of it is normal weight.
    return NORMAL_START + inner.replaceAll(NORMAL_START, "").replaceAll(NORMAL_END, "") + NORMAL_END;
};

const wrapLines = (inner: string, marker: string): string =>
    inner
        .split("\n")
        .map((line: string) => wrapLine(line, marker))
        .join("\n");

/**
 * `marker` around each run of `inner` apart. Bold leaves text marked normal weight (`unbold`) as it is and drops the
 * mark; italics and strikethrough go inside the mark as well, so the bold around them later never splits a marker.
 */
const wrapRuns = (inner: string, marker: string): string => {
    const parts: string[] = [];
    let from = 0;

    for (let start = inner.indexOf(NORMAL_START); start !== -1; start = inner.indexOf(NORMAL_START, from)) {
        const end = inner.indexOf(NORMAL_END, start);
        const normalEnd = end === -1 ? inner.length : end;
        const normal = inner.slice(start + 1, normalEnd);

        parts.push(wrapLines(inner.slice(from, start), marker), marker === "**" ? normal : NORMAL_START + wrapLines(normal, marker) + NORMAL_END);
        from = normalEnd + 1;
    }

    parts.push(wrapLines(inner.slice(from), marker));

    return parts.join("");
};

/**
 * `**`, `*` or `~~` around inline content, with its outer spaces kept outside. Content broken by `<br>` is marked line by
 * line, as Markdown emphasis cannot span lines; content holding blocks (a blank line) is left as it is, and so is
 * content whose edge is inside an emoji sequence (`splitsEmoji`). Text set back to normal weight is marked apart (`wrapRuns`).
 */
const wrap = (inner: string, marker: string, context: Context, node: Element): string => {
    const isBold = marker === "**";

    if (inner.includes("\n\n") || splitsEmoji(node, inner)) {
        return isBold ? inner.replaceAll(NORMAL_START, "").replaceAll(NORMAL_END, "") : inner;
    }

    // Each formatting element around the same lines rebuilds them: deep nesting around many lines counts against the budget.
    context.wrapWork -= inner.length;

    if (context.wrapWork < 0) {
        throw new RangeError("Nested too deep to convert");
    }

    return inner.includes(NORMAL_START) ? wrapRuns(inner, marker) : wrapLines(inner, marker);
};

/**
 * `first` before the first line of `text` and `prefix` before the others (`blank` for an empty one), code blocks in it
 * included, so a fence inside a list item or a quote stays inside it.
 */
const prefixLines = (text: string, first: string, prefix: string, blank: string, context: Context): string => {
    const prefixed = (line: string, index: number): string => {
        if (index === 0) {
            return line;
        }

        return line === "" ? blank : prefix + line;
    };

    context.indentWork -= text.length;

    for (const match of text.matchAll(PLACEHOLDER)) {
        const index = Number(match[1]);

        context.indentWork -= context.code[index]?.length ?? 0;

        context.code[index] = (context.code[index] ?? "")
            .split("\n")
            .map((line: string, lineIndex: number) => prefixed(line, lineIndex))
            .join("\n");
    }

    if (context.indentWork < 0) {
        throw new RangeError("Nested too deep to convert");
    }

    return (
        first +
        text
            .split("\n")
            .map((line: string, lineIndex: number) => prefixed(line, lineIndex))
            .join("\n")
    );
};

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
    // Markdown drops one space from each end of a code span that has one at both: a pad keeps the copied spaces.
    const pad = code.startsWith("`") || code.endsWith("`") || (code.startsWith(" ") && code.endsWith(" ")) ? " " : "";

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

/** A run of backslashes and `|`, `[` or `]`, each escaped so no backslash escapes Markdown; a backslash tail stays unless it ends the text. */
const escapeRun = (run: string, atEnd: boolean): string => {
    let end = run.length;

    while (!atEnd && run[end - 1] === "\\") {
        end -= 1;
    }

    return run.slice(0, end).replaceAll(/./g, String.raw`\$&`) + run.slice(end);
};

/** `[`, `]` and backslashes in `text` escaped for a link label, a backslash tail too: the end of `text` is the label's or a backtick's. */
const escapeLabelText = (text: string): string =>
    text.replaceAll(/[\\[\]]+/g, (run: string, offset: number, whole: string) => escapeRun(run, offset + run.length === whole.length));

/**
 * `text` with `escapeText` applied outside its code spans and `escapeCode` to them: Markdown reads a backslash in a code
 * span as itself. A span runs from a backtick run to the next run of the same length; one with no partner is text.
 * Linear: the partner of each run is found in one pass from the end.
 */
const escapeOutsideCode = (label: string, escapeText: (text: string) => string, escapeCode: (span: string) => string = (span) => span): string => {
    // Where each backtick run starts and ends.
    const starts: number[] = [];
    const ends: number[] = [];

    let index = label.indexOf("`");

    while (index !== -1) {
        let end = index + 1;

        while (label[end] === "`") {
            end += 1;
        }

        starts.push(index);
        ends.push(end);
        index = label.indexOf("`", end);
    }

    const partner: (number | undefined)[] = [];
    const nextOfLength = new Map<number, number>();

    for (let run = starts.length - 1; run >= 0; run -= 1) {
        const length = (ends[run] ?? 0) - (starts[run] ?? 0);

        partner[run] = nextOfLength.get(length);
        nextOfLength.set(length, run);
    }

    let result = "";
    let textStart = 0;
    let run = 0;

    while (run < starts.length) {
        const close = partner[run];

        if (close === undefined) {
            run += 1;
            continue;
        }

        const start = starts[run] ?? 0;
        const end = ends[close] ?? 0;

        result += escapeText(label.slice(textStart, start)) + escapeCode(label.slice(start, end));
        textStart = end;
        run = close + 1;
    }

    return result + escapeText(label.slice(textStart));
};

const escapeLinkLabel = (label: string): string => escapeOutsideCode(label, escapeLabelText);

/** `[`, `]`, `|` and backslashes in `text` escaped for a link label in a table cell: the row's pipes and the label's brackets at once. */
const escapeCellLabelText = (text: string): string =>
    text.replaceAll(/[\\[\]|]+/g, (run: string, offset: number, whole: string) => escapeRun(run, offset + run.length === whole.length));

/** Backslashes and pipes in a cell's text escaped; a backslash tail too when a code span follows, so it never escapes its backtick. */
const escapeCellText = (text: string): string =>
    text.replaceAll(/[\\|]+/g, (run: string, offset: number, whole: string) => escapeRun(run, offset + run.length === whole.length));

/** A cell's text on one line. The context is shared, not copied, so cells of tables nested in it count against the budget. */
const cellText = (cell: Element, context: Context): string => {
    const { inTable } = context;

    context.inTable = true;

    const text = styledChildren(cell, context);

    context.inTable = inTable;

    // GFM splits a row on every unescaped pipe, inside code spans too, and reads `\|` there as a pipe; a backslash in a
    // span is its own character, so only the pipes are escaped there.
    return escapeOutsideCode(oneLine(text).trim(), escapeCellText, (span) => span.replaceAll("|", String.raw`\|`));
};

const ROW_GROUPS = new Set(["TBODY", "TFOOT", "THEAD"]);

interface Row {
    element: Element;
    /** The index after the last row of its row group: no cell spans down past it. */
    groupEnd: number;
}

/**
 * The shown rows of `table` itself, read from its children and row groups: a selector would list the rows of every table
 * nested in it too, once per table around them, which grows with the square of the nesting.
 */
const ownRows = (table: Element): Row[] => {
    const groups: Element[][] = [];
    // Rows straight in the table, one group while no row group comes between them.
    let loose: Element[] | undefined;

    for (const child of table.children) {
        if (isHidden(child)) {
            continue;
        }

        if (child.tagName === "TR") {
            if (!loose) {
                loose = [];
                groups.push(loose);
            }

            loose.push(child);
        } else if (ROW_GROUPS.has(child.tagName)) {
            loose = undefined;
            groups.push([...child.children].filter((row: Element) => row.tagName === "TR" && !isHidden(row)));
        }
    }

    const rows: Row[] = [];

    for (const group of groups) {
        const groupEnd = rows.length + group.length;

        for (const element of group) {
            rows.push({ element, groupEnd });
        }
    }

    return rows;
};

const table = (element: Element, context: Context): string => {
    const rows = ownRows(element);
    const caption = [...element.children].find((child: Element) => child.tagName === "CAPTION");
    const title = caption && !isHidden(caption) ? oneLine(children(caption, context)).trim() : "";
    const texts: string[][] = [];
    let width = 0;
    let overflow = false;
    // Rows each column is still covered for by a cell above that spans down: a spanning cell keeps the cells after it under their own headers.
    const covered: number[] = [];
    const cells = rows.map(({ element: row, groupEnd }: Row, rowIndex: number) => {
        const line: string[] = [];
        const rowTexts: string[] = [];
        let column = 0;
        const skipCovered = (): void => {
            while ((covered[column] ?? 0) > 0) {
                covered[column] = (covered[column] ?? 1) - 1;
                line[column] = "";
                column += 1;
            }
        };

        for (const cell of row.children) {
            if (!(cell instanceof HTMLTableCellElement) || isHidden(cell)) {
                continue;
            }

            rowTexts.push(cellText(cell, context));

            if (overflow) {
                continue;
            }

            skipCovered();
            width = Math.max(width, column + cell.colSpan);
            overflow = width * rows.length > context.tableCells;

            if (overflow) {
                continue;
            }

            line[column] = rowTexts.at(-1) ?? "";

            // The DOM clamps both spans; a cell spans down to the end of its row group at most, and `rowspan="0"` to its end.
            const below = groupEnd - rowIndex - 1;

            for (let offset = 0; offset < cell.colSpan; offset += 1) {
                line[column + offset] ??= "";
                covered[column + offset] = cell.rowSpan === 0 ? below : Math.min(cell.rowSpan - 1, below);
            }

            column += cell.colSpan;
        }

        while (!overflow && column < covered.length) {
            skipCovered();
            column += 1;
        }

        texts.push(rowTexts);

        return line;
    });
    const before = title === "" ? "\n\n" : `\n\n${title}\n\n`;

    if (overflow) {
        return `${before}${texts.map((row: string[]) => row.filter((text: string) => text !== "").join(" ")).join("\n")}\n\n`;
    }

    if (width === 0) {
        return before;
    }

    context.tableCells -= width * rows.length;

    const line = (row: string[]): string => `| ${Array.from({ length: width }, (_: unknown, index: number) => row[index] ?? "").join(" | ")} |`;
    const [head = [], ...body] = cells;

    return `${before}${[line(head), `|${" --- |".repeat(width)}`, ...body.map((row: string[]) => line(row))].join("\n")}\n\n`;
};

/** A table inside a cell, which has no room for a grid: the text of its shown cells, a block of its own. */
const nestedTable = (element: Element, context: Context): string => {
    const texts: string[] = [];

    for (const { element: row } of ownRows(element)) {
        for (const cell of row.children) {
            if (!(cell instanceof HTMLTableCellElement) || isHidden(cell)) {
                continue;
            }

            context.tableCells -= 1;
            texts.push(oneLine(children(cell, context)).trim());
        }
    }

    const text = texts.filter((cell: string) => cell !== "").join(" ");

    return text === "" ? "" : `\n${text}\n`;
};

/** An `<ol start>` or `<li value>` number: 0 and negative ones count (Markdown cannot write the latter: see `listMarker`). */
const listNumber = (value: string | null): number | undefined => {
    const number = Number.parseInt(value ?? "", 10);

    return Number.isNaN(number) ? undefined : number;
};

const ROMAN: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
];

/** `number` as an `<ol type>` shows it: `a`…`z`, `aa`…, or lower-case roman numerals (up to 3999; past that, digits). */
const listLabel = (number: number, type: string): string => {
    if (number < 1) {
        return String(number);
    }

    if (type === "a" || type === "A") {
        let label = "";

        for (let rest = number; rest > 0; rest = Math.floor((rest - 1) / 26)) {
            label = String.fromCodePoint(97 + ((rest - 1) % 26)) + label;
        }

        return type === "A" ? label.toUpperCase() : label;
    }

    if ((type === "i" || type === "I") && number < 4000) {
        let label = "";
        let rest = number;

        for (const [value, numeral] of ROMAN) {
            label += numeral.repeat(Math.floor(rest / value));
            rest %= value;
        }

        return type === "I" ? label.toUpperCase() : label;
    }

    return String(number);
};

/** The marker of an item: a bullet, a Markdown number, or a bullet with the list's letter or numeral as text (as for Word). */
const listMarker = (ordered: boolean, type: string, number: number): string => {
    if (!ordered) {
        return "- ";
    }

    // Markdown numbers only from 0 up: a negative number is kept as text on a bullet, like a letter.
    if (number < 0) {
        return `- ${String(number)}. `;
    }

    return type === "1" || !"aAiI".includes(type) || type === "" ? `${number}. ` : `- ${listLabel(number, type)}. `;
};

const list = (listElement: Element, context: Context): string => {
    // A list straight in a list skips children(), so it counts its own depth.
    if (context.depth >= MAX_DEPTH) {
        throw new RangeError("Nested too deep to convert");
    }

    const ordered = listElement.tagName === "OL";
    // `type="a"`, `"A"`, `"i"` or `"I"`: Markdown numbers only in digits, so such a list keeps its letters as text.
    const listType = ordered ? (listElement.getAttribute("type") ?? "1") : "1";
    // A number per depth: Google Docs keeps nested items in a flat list and marks their depth with aria-level.
    const numbers: number[] = [];
    // The shown children in order. A list or text placed straight in the list, not in an item, is shown too: a list goes
    // under the item before it, anything else is an item of its own.
    const entries: { body: string; item?: Element }[] = [];

    context.depth += 1;

    for (const child of listElement.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            const text = (child.nodeValue ?? "")
                .replaceAll("\0", "")
                .replaceAll(NORMAL_START, "")
                .replaceAll(NORMAL_END, "")
                .replaceAll(HTML_SPACE, " ")
                .replaceAll(EDGE_SPACE, "");

            if (text !== "") {
                entries.push({ body: text });
            }
        } else if (child.nodeType === Node.ELEMENT_NODE && !isHidden(child as Element)) {
            const childElement = child as Element;
            const previous = entries.at(-1);

            const { inListItem } = context;

            if (childElement.tagName === "LI") {
                context.inListItem = true;
                entries.push({ body: styledChildren(childElement, context), item: childElement });
                context.inListItem = inListItem;
            } else if ((childElement.tagName === "UL" || childElement.tagName === "OL") && previous) {
                context.inListItem = true;
                previous.body += element(childElement, context);
                context.inListItem = inListItem;
            } else {
                const body = element(childElement, context);

                if (body.trim() !== "") {
                    entries.push({ body });
                }
            }
        }
    }

    context.depth -= 1;

    const ariaLevels = entries.map(({ item }) => {
        const ariaLevel = item ? Number.parseInt(item.getAttribute("aria-level") ?? "1", 10) || 1 : undefined;

        return ariaLevel === undefined ? undefined : Math.min(Math.max(ariaLevel, 1), 6);
    });
    // A copy that starts at a nested item keeps its nesting, but from the left edge: deeper is a code block in Markdown.
    let topLevel = 6;

    for (const ariaLevel of ariaLevels) {
        topLevel = Math.min(topLevel, ariaLevel ?? topLevel);
    }

    const items: string[] = [];
    let level = 1;
    // A reversed list counts down from its start, or from its number of top-level items.
    const reversed = ordered && listElement.hasAttribute("reversed");
    const firstNumber = listNumber(listElement.getAttribute("start")) ?? (reversed ? ariaLevels.filter((ariaLevel) => ariaLevel === topLevel).length : 1);

    for (const [index, { body, item }] of entries.entries()) {
        const ariaLevel = ariaLevels[index];

        // Text outside an item stays at the depth of the item before it.
        level = ariaLevel === undefined ? level : ariaLevel - topLevel + 1;

        const number = (ordered && item ? listNumber(item.getAttribute("value")) : undefined) ?? numbers[level - 1] ?? (level === 1 ? firstNumber : 1);

        numbers.length = level;
        // A reversed list counts on below 0: such numbers are kept as text (`listMarker`).
        numbers[level - 1] = reversed && level === 1 ? number - 1 : number + 1;
        items.push(listItem(body.replaceAll(BLANK_LINES, "\n\n").trim(), level, listMarker(ordered, listType, number), context));
    }

    // In an item, one break: a blank line between the item's text and its sub-list would make the whole outer list loose.
    // A numbered list not starting at 1 cannot interrupt the text, so it keeps the blank line.
    const tight = context.inListItem === true && (!ordered || firstNumber === 1);

    return `${tight ? "\n" : "\n\n"}${items.join("\n")}\n\n`;
};

/** A list item at depth `level` (from 1): every line of it indented to that depth, code blocks included. */
const listItem = (body: string, level: number, marker: string, context: Context): string => {
    const indent = " ".repeat(4 * (level - 1));

    return prefixLines(body, indent + marker, indent + " ".repeat(marker.length), "", context);
};

/** Word writes a list as paragraphs with `mso-list` styles and the bullet as hidden text. */
const wordListItem = (element: Element, inner: string, context: Context): string | undefined => {
    const level = WORD_LIST_LEVEL.exec(styleOf(element));

    if (!level) {
        return undefined;
    }

    // The first bullet the paragraph shows: one inside hidden text is not its marker.
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node: Node) => {
            if (isWordBullet(node as Element)) {
                return NodeFilter.FILTER_ACCEPT;
            }

            return isHidden(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        },
    });
    const bullet = (walker.nextNode()?.textContent ?? "").trim();
    let marker = "- ";

    if (WORD_ORDERED_MARKER.test(bullet)) {
        marker = `${bullet.slice(0, -1)}. `;
    } else if (WORD_LETTERED_MARKER.test(bullet)) {
        marker = `- ${bullet} `;
    }

    return `\n${listItem(inner.trim(), Math.max(Number(level[1]) - context.wordTopLevel + 1, 1), marker, context)}\n`;
};

/** The Markdown for the child nodes, with the bold, italics or strikethrough the element's own style gives them. */
function styledChildren(node: Element, context: Context): string {
    const style = styleOf(node);
    const isBold = isBoldStyle(style);

    context.bold += isBold ? 1 : 0;

    let inner = children(node, context);

    context.bold -= isBold ? 1 : 0;

    if (isBold) {
        inner = wrap(inner, "**", context, node);
    } else if (isNormalWeight(style)) {
        inner = unbold(inner, context);
    }

    inner = isItalicStyle(style) ? wrap(inner, "*", context, node) : inner;

    return STRIKE_STYLE.test(style) ? wrap(inner, "~~", context, node) : inner;
}

/** A list inside a table cell: its shown items' text on one line, separated by "; ". */
const cellList = (listElement: Element, context: Context): string => {
    const items: string[] = [];

    for (const child of listElement.children) {
        if (child.tagName !== "LI" || isHidden(child)) {
            continue;
        }

        const text = oneLine(children(child, context)).trim();

        if (text !== "") {
            items.push(text);
        }
    }

    return ` ${items.join("; ")} `;
};

const element = (node: Element, context: Context): string => {
    const tag = node.tagName.toUpperCase();
    const style = styleOf(node);

    if (isHidden(node)) {
        return "";
    }

    switch (tag) {
        case "A": {
            const text = children(node, context);
            const href = safeHref(node);

            // A label broken by `<br>` stays one link (a label may span lines); one holding blocks cannot.
            if (!href || text.trim() === "" || text.includes("\n\n")) {
                return text;
            }

            const core = text.trim();
            const start = text.indexOf(core);

            if (context.inTable) {
                // Escaped for the row here and set aside, so the cell's own escaping never escapes the label's backslashes again.
                const label = escapeOutsideCode(oneLine(core), escapeCellLabelText, (span) => span.replaceAll("|", String.raw`\|`));
                const cellHref = href.replaceAll("|", String.raw`\|`);

                context.code.push(label === cellHref ? cellHref : `[${label}](${cellHref})`);

                return `${text.slice(0, start)}\0${context.code.length - 1}\0${text.slice(start + core.length)}`;
            }

            const label = escapeLinkLabel(core);
            const link = label === href ? href : `[${label}](${href})`;

            // The spaces around the label stay outside the link: they part it from the words beside it.
            return text.slice(0, start) + link + text.slice(start + core.length);
        }
        case "B":
        case "STRONG": {
            // Google Docs wraps the whole copy in `<b style="font-weight:normal">`.
            if (isNormalWeight(style)) {
                return unbold(children(node, context), context);
            }

            context.bold += 1;

            const inner = children(node, context);

            context.bold -= 1;

            return wrap(inner, "**", context, node);
        }
        case "BLOCKQUOTE": {
            // A table cell holds inline content only: a quote there is its text.
            if (context.inTable) {
                return ` ${children(node, context)} `;
            }

            const inner = children(node, context).replaceAll(BLANK_LINES, "\n\n").trim();

            return `\n\n${prefixLines(inner, "> ", "> ", ">", context)}\n\n`;
        }
        case "BR": {
            return context.inTable ? " " : "\n";
        }
        case "CODE":
        case "KBD":
        case "SAMP":
        case "TT": {
            return inlineCode(codeText(node));
        }
        case "DEL":
        case "S":
        case "STRIKE": {
            return wrap(children(node, context), "~~", context, node);
        }
        case "DETAILS": {
            // A closed one shows its summary alone.
            if (!node.hasAttribute("open")) {
                const summary = [...node.children].find((child: Element) => child.tagName === "SUMMARY");

                return summary ? element(summary, context) : "";
            }

            break;
        }
        case "EM":
        case "I": {
            return wrap(children(node, context), "*", context, node);
        }
        case "HR": {
            return "\n\n---\n\n";
        }
        case "IMG": {
            // Emoji and formulas drawn as pictures are text; other images arrive as files, if at all.
            const alt = node.getAttribute("alt")?.trim() ?? "";

            if (MATH_CLASS.test(node.getAttribute("class") ?? "") && alt !== "") {
                return inlineMath(alt);
            }

            return EMOJI_NAME.test(alt) || (alt.length <= 16 && PICTOGRAPHIC.test(alt) && EMOJI_ONLY.test(alt)) ? alt : "";
        }
        case "INPUT": {
            if (node.getAttribute("type")?.toLowerCase() !== "checkbox") {
                return "";
            }

            return node.hasAttribute("checked") ? "[x] " : "[ ] ";
        }
        case "MATH": {
            const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();

            if (tex) {
                return inlineMath(tex);
            }

            // No TeX source: the formula's visible text, as the page shows it.
            break;
        }
        case "OL":
        case "UL": {
            // A table cell holds inline content only: its list items go on the cell's line, apart.
            return context.inTable ? cellList(node, context) : list(node, context);
        }
        case "PRE": {
            const code = codeText(node);

            if (context.inTable) {
                return inlineCode(code);
            }

            context.code.push(fenceCode(code, languageOf(node)));

            return `\n\n\0${context.code.length - 1}\0\n\n`;
        }
        case "SUB":
        case "SUP": {
            // Only when every character has a form: an ordinal (`12<sup>th</sup>`) or footnote mark stays as copied.
            const inner = styledChildren(node, context);
            const forms = tag === "SUP" ? SUPERSCRIPT : SUBSCRIPT;
            const chars = [...inner];

            return chars.every((char: string) => forms.has(char)) ? chars.map((char: string) => forms.get(char)).join("") : inner;
        }
        case "TABLE": {
            return context.inTable ? nestedTable(node, context) : table(node, context);
        }
        default: {
            break;
        }
    }

    if (HEADING.test(tag)) {
        // Outside a table a placeholder is a fenced block (`<pre>`): it goes below the heading, which holds one line.
        const blocks: string[] = [];
        const inner = children(node, context);
        const text = (
            context.inTable
                ? inner
                : inner.replaceAll(PLACEHOLDER, (placeholder: string) => {
                      blocks.push(placeholder);

                      return "";
                  })
        )
            .split("\n")
            .map((line: string) => line.trim())
            .filter(Boolean)
            .join(" ");

        // A table cell holds inline content only: a heading there is its text, in bold.
        if (context.inTable) {
            return text === "" ? "" : ` ${wrapLine(text, "**")} `;
        }

        const heading = text === "" ? "" : `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n`;

        return heading + blocks.map((block: string) => `\n\n${block}\n\n`).join("");
    }

    const inner = styledChildren(node, context);

    if (tag === "SPAN" || tag === "FONT") {
        return inner;
    }

    if (tag === "P") {
        const item = wordListItem(node, inner, context);

        if (item !== undefined) {
            return item;
        }
    }

    if (BLOCKS.has(tag)) {
        return `\n\n${inner.trim()}\n\n`;
    }

    return LINE_BLOCKS.has(tag) || tag === "LI" || tag === "TR" ? `\n${inner.trim()}\n` : inner;
};

/** The Markdown for the child nodes, without the spaces that collapsed HTML whitespace leaves around line breaks. */
function children(node: Node, context: Context): string {
    if (context.depth >= MAX_DEPTH) {
        throw new RangeError("Nested too deep to convert");
    }

    // Parts, not one growing string: a long page has thousands of blocks, and re-reading the whole text for each is quadratic.
    const parts: string[] = [];

    context.depth += 1;

    for (const child of node.childNodes) {
        let next = "";

        // A `<br>` is a line of its own: two in a row leave a blank line, where two line blocks in a row share a break.
        const isBreak = child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === "BR";

        if (child.nodeType === Node.TEXT_NODE) {
            next = (child.nodeValue ?? "").replaceAll("\0", "").replaceAll(NORMAL_START, "").replaceAll(NORMAL_END, "").replaceAll(HTML_SPACE, " ");
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            next = element(child as Element, context);
        }

        if (next === "") {
            continue;
        }

        if (next.startsWith("\n")) {
            while (parts.length > 0) {
                const last = trimSpacesEnd(parts.at(-1) ?? "");

                if (last !== "") {
                    parts[parts.length - 1] = last;
                    break;
                }

                parts.pop();
            }
        }

        if (parts.at(-1)?.endsWith("\n")) {
            // Two line blocks in a row (a div per line) share one line break; a paragraph keeps its blank line, and a nested
            // list item its indent.
            if (!next.startsWith("\n")) {
                next = trimSpacesStart(next);
            } else if (!next.startsWith("\n\n") && !isBreak) {
                next = next.slice(1);
            }
        }

        parts.push(next);
    }

    context.depth -= 1;

    return parts.join("");
}

/** The text a clipboard `text/html` payload shows, no Markdown added: hidden parts left out, code indentation kept. */
export const visibleText = (html: string): string =>
    codeText(new DOMParser().parseFromString(html, "text/html").body, true)
        .split("\n")
        .map((line: string) => trimSpacesEnd(line))
        .join("\n")
        .replaceAll(BLANK_LINES, "\n\n")
        .replace(LEADING_NEWLINE, "")
        .replace(TRAILING_NEWLINE, "");

/** The Markdown for a clipboard `text/html` payload; empty when it holds no text. */
export const htmlToMarkdown = (html: string): string => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const context: Context = {
        bold: 0,
        code: [],
        depth: 0,
        indentWork: MAX_INDENT_WORK,
        inTable: false,
        tableCells: MAX_TABLE_CELLS,
        wordTopLevel: 9,
        wrapWork: MAX_WRAP_WORK,
    };

    // Only the paragraphs the walk shows: one in hidden text or in code never sets where the list starts.
    const paragraphs = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node: Node) => {
            const tag = (node as Element).tagName.toUpperCase();

            if (isHidden(node as Element) || NOT_WALKED.has(tag)) {
                return NodeFilter.FILTER_REJECT;
            }

            return tag === "P" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });

    for (let paragraph = paragraphs.nextNode(); paragraph; paragraph = paragraphs.nextNode()) {
        const level = WORD_LIST_LEVEL.exec(styleOf(paragraph as Element));

        if (level) {
            context.wordTopLevel = Math.min(context.wordTopLevel, Number(level[1]));
        }
    }

    return (
        children(parsed.body, context)
            .split("\n")
            .map((line: string) => trimSpacesEnd(line))
            .join("\n")
            .replaceAll(BLANK_LINES, "\n\n")
            .trim()
            .replaceAll(PLACEHOLDER, (_: string, index: string) => context.code[Number(index)] ?? "")
            // Marks in text bold never reached (a link label in a table cell is set aside before it).
            .replaceAll(NORMAL_START, "")
            .replaceAll(NORMAL_END, "")
    );
};
