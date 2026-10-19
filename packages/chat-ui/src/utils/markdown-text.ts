/**
 * Markdown to readable plain text, for "Copy as plain text", plus the last
 * fenced code block for the copy-last-code-block shortcut.
 *
 * Line-based and fence-aware rather than a parser: fenced code is kept verbatim,
 * everything else loses only its markup. Anything it does not recognise passes
 * through unchanged, which is the right failure for copied text.
 */

// CommonMark: a fence may be indented 0-3 spaces; 4+ is indented code, literal text.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FOUR_SPACE_INDENT_RE = /^ {4,}/;
const FENCE_CLOSE_RE = /^(?:`+|~+)$/;
const HEADING_OPEN_RE = /^ {0,3}#{1,6} (.*)$/;
const BLOCKQUOTE_RE = /^ {0,3}> ?/;
const BULLET_RE = /^([ \t]*)[-*+][ \t]+/;
const ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|~>])/g;
const TABLE_CELL_SEPARATOR_RE = /^ *:?-+:? *$/;
const RULE_MARKS_RE = /^(?:-+|\*+|_+)$/;
const SPACE_OR_TAB_RE = /[ \t]/g;
const LEADING_PIPE_RE = /^\|/;
const BLANK_RUN_RE = /\n{3,}/g;
const CRLF_RE = /\r\n/g;

// Markup, in the order the passes run. Each pass is a separate constant so a
// rule that does not match leaves the rest untouched.
const WHITESPACE_RE = /\s/;
const AUTOLINK_RE = /<((?:https?|mailto):[^>\s]+)>/g;
const STRONG_STAR_RE = /\*\*([^*\n]+)\*\*/g;
const STRIKE_RE = /~~([^~\n]+)~~/g;
const STRONG_UNDERSCORE_RE = /\b__([^_\n]+)__\b/g;
const EMPHASIS_STAR_RE = /(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g;
// `_x_` only at word boundaries, so `snake_case_name` and `__init__` are left alone.
const EMPHASIS_UNDERSCORE_RE = /\b_([^_\n]+)_\b/g;

/** Private-use markers for masked inline code and escaped characters; not in normal text. */
const CODE_MARK = "";
const ESCAPE_MARK = "";
const CODE_RESTORE_RE = new RegExp(String.raw`${CODE_MARK}(\d+)${CODE_MARK}`, "g");
const ESCAPE_RESTORE_RE = new RegExp(String.raw`${ESCAPE_MARK}(\d+)${ESCAPE_MARK}`, "g");

/** Number of pipes that delimit cells: a `\|` is cell text, and `\\|` is an escaped backslash before a delimiter. */
const pipeCount = (line: string): number => {
    let count = 0;

    for (let index = 0; index < line.length; index += 1) {
        if (line[index] === "\\") {
            index += 1;
        } else if (line[index] === "|") {
            count += 1;
        }
    }

    return count;
};

/** Splits row text on its unescaped pipes. Escapes stay in the cell; `stripInline` turns `\|` into `|`. */
const splitCells = (text: string): string[] => {
    const cells: string[] = [];
    let current = "";

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] ?? "";

        if (character === "\\" && index + 1 < text.length) {
            current += character + (text[index + 1] ?? "");
            index += 1;
        } else if (character === "|") {
            cells.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    cells.push(current);

    return cells;
};

/** A table row without its outer pipes, split into trimmed cells. */
const tableCells = (line: string): string[] => {
    const cells = splitCells(line.trim().replace(LEADING_PIPE_RE, "")).map((cell) => cell.trim());

    // A trailing delimiter pipe leaves an empty last cell; an escaped one never does.
    if (cells.length > 1 && cells[cells.length - 1] === "") {
        cells.pop();
    }

    return cells;
};

const isTableSeparator = (line: string): boolean => tableCells(line).every((cell) => TABLE_CELL_SEPARATOR_RE.test(cell));

const isRule = (line: string): boolean => {
    const marks = line.replaceAll(SPACE_OR_TAB_RE, "");

    return marks.length >= 3 && RULE_MARKS_RE.test(marks);
};

/** Text of an ATX heading (`## Title ##` gives `Title`), or undefined when the line is not one. */
const headingText = (line: string): string | undefined => {
    const match = HEADING_OPEN_RE.exec(line);

    if (!match) {
        return undefined;
    }

    const text = (match[1] ?? "").trim();
    let end = text.length;

    while (end > 0 && text[end - 1] === "#") {
        end -= 1;
    }

    // Closing hashes count only after a space, so `C#` keeps its `#`.
    return end < text.length && (end === 0 || text[end - 1] === " ") ? text.slice(0, end).trimEnd() : text;
};

/**
 * Replaces each inline code span with a marker and records its text. A run of
 * backticks closes only on a run of the same length, as in CommonMark.
 */
const maskInlineCode = (text: string, codes: string[]): string => {
    let masked = "";
    let index = 0;

    while (index < text.length) {
        if (text[index] !== "`") {
            masked += text[index];
            index += 1;
            continue;
        }

        let ticks = 0;

        while (text[index + ticks] === "`") {
            ticks += 1;
        }

        const run = "`".repeat(ticks);
        const close = text.indexOf(run, index + ticks);

        if (close === -1 || text[close + ticks] === "`") {
            masked += run;
            index += ticks;
            continue;
        }

        codes.push(text.slice(index + ticks, close));
        masked += `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
        index = close + ticks;
    }

    return masked;
};

/**
 * `[text](url)` → `text`, and `![alt](src)` → `alt`. A scan rather than a regex:
 * a `[^\]]*`-style pattern backtracks badly on a line of unmatched brackets.
 */
const stripLinks = (text: string): string => {
    let result = "";
    let index = 0;
    let open = text.indexOf("[");

    while (open !== -1) {
        const close = text.indexOf("]", open);
        const end = close !== -1 && text[close + 1] === "(" ? text.indexOf(")", close + 2) : -1;

        if (end === -1) {
            open = text.indexOf("[", open + 1);
            continue;
        }

        const image = open - 1 >= index && text[open - 1] === "!";

        result += text.slice(index, image ? open - 1 : open) + text.slice(open + 1, close);
        index = end + 1;
        open = text.indexOf("[", index);
    }

    return result + text.slice(index);
};

const stripMarkup = (text: string): string =>
    stripLinks(text)
        .replaceAll(AUTOLINK_RE, "$1")
        .replaceAll(STRONG_STAR_RE, "$1")
        .replaceAll(STRIKE_RE, "$1")
        // `__x__` is emphasis only with a space inside: `__init__` is an identifier.
        .replaceAll(STRONG_UNDERSCORE_RE, (match, inner: string) => (WHITESPACE_RE.test(inner) ? inner : match))
        .replaceAll(EMPHASIS_STAR_RE, "$1$2")
        .replaceAll(EMPHASIS_UNDERSCORE_RE, "$1");

/**
 * Inline code and backslash escapes are masked before the markup pass, so an
 * escaped `\*` is not read as emphasis, and both are restored verbatim after it.
 */
const stripInline = (text: string): string => {
    const codes: string[] = [];
    const escapes: string[] = [];
    const masked = maskInlineCode(text, codes).replaceAll(ESCAPE_RE, (_match, character: string) => {
        escapes.push(character);

        return `${ESCAPE_MARK}${escapes.length - 1}${ESCAPE_MARK}`;
    });

    return stripMarkup(masked)
        .replaceAll(ESCAPE_RESTORE_RE, (_match, index: string) => escapes[Number(index)] ?? "")
        .replaceAll(CODE_RESTORE_RE, (_match, index: string) => codes[Number(index)] ?? "");
};

/** `null` for a line with no text of its own (a rule). Pipes stay: only a table turns them into cells. */
const convertLine = (line: string): string | null => {
    if (isRule(line)) {
        return null;
    }

    const heading = headingText(line);
    const text = heading ?? line.replace(BLOCKQUOTE_RE, "").replace(BULLET_RE, (_match, indent: string) => `${indent}• `);

    return stripInline(text);
};

const isFenceClose = (line: string, fence: string): boolean => {
    if (FOUR_SPACE_INDENT_RE.test(line)) {
        return false;
    }

    const closing = line.trim();

    return closing.length >= fence.length && closing[0] === fence[0] && FENCE_CLOSE_RE.test(closing);
};

/** A GFM table starts at a row with pipes that is followed by a separator row with as many cells. */
const isTableStart = (line: string, next: string | undefined): boolean =>
    next !== undefined && pipeCount(line) >= 1 && pipeCount(next) >= 1 && isTableSeparator(next) && tableCells(line).length === tableCells(next).length;

/** A table row as tab-separated plain cells. */
const tableRowText = (line: string): string =>
    tableCells(line)
        .map((cell) => stripInline(cell))
        .join("\t");

/**
 * The table whose header is `lines[start]`: its text rows, and the index of its last
 * line. The separator row is markup; the body rows run until a row without pipes.
 */
const readTable = (lines: string[], start: number): { end: number; rows: string[] } => {
    const rows = [tableRowText(lines[start] ?? "")];
    let end = start + 1;

    while (end + 1 < lines.length && pipeCount(lines[end + 1] ?? "") >= 1) {
        end += 1;
        rows.push(tableRowText(lines[end] ?? ""));
    }

    return { end, rows };
};

/**
 * Plain text of a markdown string. Lists keep their bullets and numbers, link
 * and image text is kept, code fences keep their code, and table rows become
 * tab-separated cells.
 */
export const markdownToPlainText = (markdown: string): string => {
    const output: string[] = [];
    const lines = markdown.replaceAll(CRLF_RE, "\n").split("\n");
    let fence: string | undefined;

    // Last line of the table already written out; its rows are skipped below.
    let tableEnd = -1;

    for (let index = 0; index < lines.length; index += 1) {
        if (index <= tableEnd) {
            continue;
        }

        const line = lines[index] ?? "";

        if (fence !== undefined) {
            if (isFenceClose(line, fence)) {
                fence = undefined;
            } else {
                output.push(line);
            }

            continue;
        }

        const marker = FENCE_OPEN_RE.exec(line)?.[1];

        if (marker) {
            fence = marker;
            continue;
        }

        if (isTableStart(line, lines[index + 1])) {
            const table = readTable(lines, index);

            output.push(...table.rows);
            tableEnd = table.end;

            continue;
        }

        const converted = convertLine(line);

        if (converted !== null) {
            output.push(converted);
        }
    }

    return output.join("\n").replaceAll(BLANK_RUN_RE, "\n\n").trim();
};

/** Body of the last fenced code block in `markdown`, or `null` when there is none. */
export const extractLastCodeBlock = (markdown: string): string | null => {
    let last: string[] | null = null;
    let current: string[] | null = null;
    let fence: string | undefined;

    for (const line of markdown.replaceAll(CRLF_RE, "\n").split("\n")) {
        if (fence !== undefined) {
            if (isFenceClose(line, fence)) {
                last = current;
                current = null;
                fence = undefined;
            } else {
                current?.push(line);
            }

            continue;
        }

        const marker = FENCE_OPEN_RE.exec(line)?.[1];

        if (marker) {
            fence = marker;
            current = [];
        }
    }

    // A block still open at the end (a reply still streaming) counts as the last one.
    const block = current ?? last;

    return block === null ? null : block.join("\n");
};
