/**
 * GitHub Flavored Markdown: tables, strikethrough and task list items, as a plugin (`service.use(gfm)`).
 *
 * A table is built from the DOM, not from its converted children: each cell's converted text is kept for the cell,
 * and the table rule lays the cells out on a grid, so a cell that spans columns or rows keeps the cells after it under
 * their own headers. An element that a remove rule drops is left out of the grid.
 */
import type TurndownService from "./turndown";
import type { AnnotatedNode, Options, Rule, RuleLookup } from "./types";

// A table with more cells than this, once its spans are laid out, is written as the text of its cells, a line per row:
// a grid that big would only bury its text in pipes.
const MAX_TABLE_CELLS = 100_000;
const ROW_GROUPS = new Set(["TBODY", "TFOOT", "THEAD"]);
const CELLS = new Set(["TD", "TH"]);
// The leading digits of a span attribute, as HTML reads it: `2abc` is 2.
const LEADING_DIGITS = /^\s*(\d+)/;
const PIPE = /\|/g;
const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const LISTS = new Set(["OL", "UL"]);
const BLOCKS_IN_CELL = new Set(["BLOCKQUOTE", "DIV", "P"]);

/** The converted text of each cell and caption, on one line, kept until its table is written. */
const cellTexts = new WeakMap<Node, string>();

interface Row {
    element: Element;
    /** The index after the last row of its row group: no cell spans down past it. */
    groupEnd: number;
}

/** An element's child elements. Read by index: domino's HTMLCollection is not iterable. */
function childElements(element: Element): Element[] {
    const { children } = element;

    return Array.from({ length: children.length }, (_unused, index) => children[index]).filter((child) => child !== undefined);
}

function isRemoved(node: Node, lookup: RuleLookup): boolean {
    return lookup.isRemoved(node);
}

/**
 * The nearest ancestor whose name is in `names`, or null. Each answer is kept per node and shared with the nodes below
 * it, so a filter that asks for every element of a deeply nested document walks each ancestor once, not once per node.
 */
function nearestAncestor(node: Node, names: ReadonlySet<string>, known: WeakMap<Node, Element | null>): Element | null {
    const path: Node[] = [];
    let current = node.parentNode;
    let found: Element | null = null;

    while (current) {
        if (names.has(current.nodeName)) {
            found = current as Element;
            break;
        }

        // A node's own answer is its nearest match above it, which is this node's too: the node itself is no match.
        const cached = known.get(current);

        if (cached !== undefined) {
            found = cached;
            break;
        }

        path.push(current);
        current = current.parentNode;
    }

    // Every node on the path has the same nearest ancestor, found above it.
    for (const passed of path) {
        known.set(passed, found);
    }

    known.set(node, found);

    return found;
}

const TABLE_NAMES = new Set(["TABLE"]);
const STRIKE_NAMES = new Set(["DEL", "S", "STRIKE"]);
const cellAncestors = new WeakMap<Node, Element | null>();
const tableAncestors = new WeakMap<Node, Element | null>();

/** The table cell the node is in, or null. */
function cellOf(node: Node): Element | null {
    return nearestAncestor(node, CELLS, cellAncestors);
}

/** The table that owns a row or a cell: the nearest table element above it. */
function tableOf(node: Node): Element | null {
    return nearestAncestor(node, TABLE_NAMES, tableAncestors);
}

/** Text on one line: each line break and the whitespace around it becomes one space. */
function oneLine(text: string): string {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join(" ");
}

/** The cells of a row, read from its children: a row's cells are its own, never those of a table nested in a cell. */
function ownCells(row: Element, lookup: RuleLookup): Element[] {
    return childElements(row).filter((cell) => CELLS.has(cell.nodeName) && !isRemoved(cell, lookup));
}

/** The row groups of a table, in the order it shows them: its head first and its footer last, wherever they are. */
interface Sections {
    body: Element[][];
    foot: Element[][];
    head: Element[][];
}

/** Which section a row group belongs to. */
function sectionOf(sections: Sections, name: string): Element[][] {
    if (name === "THEAD") {
        return sections.head;
    }

    return name === "TFOOT" ? sections.foot : sections.body;
}

/** The row groups of the table that a remove filter keeps. Rows straight in the table form one group until a row group. */
function sectionsOf(table: Element, lookup: RuleLookup): Sections {
    const sections: Sections = { body: [], foot: [], head: [] };
    let loose: Element[] | undefined;

    for (const child of childElements(table)) {
        if (isRemoved(child, lookup)) {
            continue;
        }

        if (child.nodeName === "TR") {
            if (!loose) {
                loose = [];
                sections.body.push(loose);
            }

            loose.push(child);
        } else if (ROW_GROUPS.has(child.nodeName)) {
            loose = undefined;
            sectionOf(sections, child.nodeName).push(groupRows(child, lookup));
        }
    }

    return sections;
}

/**
 * The rows of the table itself, read from its children and row groups: a selector would list the rows of every table
 * nested in it too, once per table around them, which grows with the square of the nesting.
 */
function ownRows(table: Element, lookup: RuleLookup): Row[] {
    const { body, foot, head } = sectionsOf(table, lookup);
    const rows: Row[] = [];

    for (const group of [...head, ...body, ...foot]) {
        const groupEnd = rows.length + group.length;

        for (const element of group) {
            rows.push({ element, groupEnd });
        }
    }

    return rows;
}

/** The rows of a row group that a remove filter keeps. */
function groupRows(group: Element, lookup: RuleLookup): Element[] {
    return childElements(group).filter((row) => row.nodeName === "TR" && !isRemoved(row, lookup));
}

/** A span attribute as the DOM clamps it: `colspan` 1 to 1000, `rowspan` 0 to 65534, where 0 spans to the group's end. */
function span(cell: Element, name: "colspan" | "rowspan"): number {
    const digits = LEADING_DIGITS.exec(cell.getAttribute(name) ?? "")?.[1];
    const value = digits === undefined ? NaN : Number(digits);

    if (name === "colspan") {
        return Number.isNaN(value) || value < 1 ? 1 : Math.min(value, 1000);
    }

    return Number.isNaN(value) || value < 0 ? 1 : Math.min(value, 65_534);
}

/** The rows of a table laid out on a grid, or null when the grid would hold more than MAX_TABLE_CELLS cells. */
function grid(rows: ReadonlyArray<Row>, lookup: RuleLookup): { lines: string[][]; width: number } | null {
    // For each column, the row index from which no cell above covers it. A cell that overlaps one above, which HTML
    // calls a table model error, keeps the longer cover, so the rows below still skip the column.
    const coveredUntil: number[] = [];
    const lines: string[][] = [];
    let width = 0;

    for (const [rowIndex, { element: row, groupEnd }] of rows.entries()) {
        const line: string[] = [];
        let column = 0;

        for (const cell of ownCells(row, lookup)) {
            while ((coveredUntil[column] ?? 0) > rowIndex) {
                column += 1;
            }

            const columns = span(cell, "colspan");
            const rowSpan = span(cell, "rowspan");
            // A cell spans down to the end of its row group at most, and `rowspan="0"` to that end.
            const until = rowSpan === 0 ? groupEnd : Math.min(rowIndex + rowSpan, groupEnd);

            width = Math.max(width, column + columns);

            if (width * rows.length > MAX_TABLE_CELLS) {
                return null;
            }

            line[column] = cellTexts.get(cell) ?? "";

            for (let offset = 0; offset < columns; offset += 1) {
                coveredUntil[column + offset] = Math.max(coveredUntil[column + offset] ?? 0, until);
            }

            column += columns;
        }

        lines.push(line);
    }

    return { lines, width };
}

const ITEM_SEPARATOR = "; ";

/** True when a list item that a remove filter keeps follows this one. */
function hasNextItem(item: Element, lookup: RuleLookup): boolean {
    for (let next = item.nextElementSibling; next; next = next.nextElementSibling) {
        if (next.nodeName === "LI" && !lookup.isRemoved(next)) {
            return true;
        }
    }

    return false;
}

/** True when the item's first content is a nested list: no text comes before it. */
function isOpenedByList(item: Element): boolean {
    for (let child = item.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
            return LISTS.has(child.nodeName);
        }

        if (child.nodeType === 3 && (child.nodeValue ?? "").trim() !== "") {
            return false;
        }
    }

    return false;
}

/** A code block's text, read from the DOM: a `<br>` is a line break, and an element a remove filter drops is left out. */
function codeText(node: Node, lookup: RuleLookup): string {
    let text = "";

    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3 || child.nodeType === 4) {
            text += child.nodeValue ?? "";
        } else if (child.nodeName === "BR") {
            text += "\n";
        } else if (child.nodeType === 1 && !lookup.isRemoved(child)) {
            text += codeText(child, lookup);
        }
    }

    return text;
}

/** The text as a code span, its fence longer than any backtick run inside, padded where the text meets a backtick. */
function inlineCode(text: string): string {
    if (text === "") {
        return "";
    }

    let longest = 0;
    let run = 0;

    for (const char of text) {
        run = char === "`" ? run + 1 : 0;
        longest = Math.max(longest, run);
    }

    const fence = "`".repeat(longest + 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";

    return `${fence}${pad}${text}${pad}${fence}`;
}

function captionText(caption: Element): string {
    return cellTexts.get(caption) ?? "";
}

function tableReplacement(_content: string, node: AnnotatedNode, _options: Options, lookup: RuleLookup): string {
    const rows = ownRows(node, lookup);

    // A table in a cell has no room for a grid: it is the text of its cells, inside the cell's line.
    const caption = childElements(node).find((child) => child.nodeName === "CAPTION" && !isRemoved(child, lookup));
    const title = caption === undefined ? "" : captionText(caption);

    if (cellOf(node)) {
        const texts = rows.flatMap(({ element }) => ownCells(element, lookup).map((cell) => cellTexts.get(cell) ?? ""));

        return ` ${[title, ...texts].filter((text) => text !== "").join(" ")} `;
    }

    const before = title === "" ? "\n\n" : `\n\n${title}\n\n`;
    const laidOut = grid(rows, lookup);

    if (!laidOut) {
        const text = rows.map(({ element }) =>
            ownCells(element, lookup)
                .map((cell) => cellTexts.get(cell) ?? "")
                .filter((cellText) => cellText !== "")
                .join(" "),
        );

        return `${before}${text.join("\n")}\n\n`;
    }

    const { lines, width } = laidOut;

    if (width === 0) {
        return before;
    }

    // GFM splits a row on every unescaped pipe, code spans included, so every pipe is escaped, once, here: a nested
    // table's text is kept unescaped until the outer table writes it.
    const line = (cells: ReadonlyArray<string>): string =>
        `| ${Array.from({ length: width }, (_unused, index) => (cells[index] ?? "").replaceAll(PIPE, String.raw`\|`)).join(" | ")} |`;
    const [head = [], ...body] = lines;

    return `${before}${[line(head), `|${" --- |".repeat(width)}`, ...body.map((cells) => line(cells))].join("\n")}\n\n`;
}

const tableRules: Record<string, Rule> = {
    blockInCell: {
        filter: (node, _options, lookup) => BLOCKS_IN_CELL.has(node.nodeName) && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement: (content) => ` ${oneLine(content)} `,
    },

    // A code block has no place on a table row either: it is inline code, its lines joined by spaces.
    codeBlockInCell: {
        filter: (node, _options, lookup) => node.nodeName === "PRE" && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement: (_content, node, _options, lookup) => ` ${inlineCode(oneLine(codeText(node, lookup)))} `,
    },

    headingInCell: {
        filter: (node, _options, lookup) => HEADINGS.has(node.nodeName) && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, _node, options) {
            const text = oneLine(content);

            return text === "" ? "" : ` ${options.strongDelimiter}${text}${options.strongDelimiter} `;
        },
    },

    // Blocks have no place on a table row. Inside a cell a list is its items joined by `; `, a heading is strong text,
    // and a paragraph or a quote is its text.
    // A list nested in an item is a list of more items, so it is kept apart from the item's own text by the separator.
    listInCell: {
        filter: (node, _options, lookup) => LISTS.has(node.nodeName) && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, node) {
            const items = content.trim();

            if (node.parentNode?.nodeName === "LI") {
                return `${ITEM_SEPARATOR}${items} `;
            }

            return ` ${items} `;
        },
    },

    listItemInCell: {
        filter: (node, _options, lookup) => node.nodeName === "LI" && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, node, _options, lookup) {
            const text = oneLine(content);
            // Only the separator a nested list writes is taken off; a semicolon the item's own text starts with stays.
            const own = isOpenedByList(node) ? text.slice(ITEM_SEPARATOR.trim().length).trim() : text;

            return `${own}${hasNextItem(node, lookup) ? ITEM_SEPARATOR : ""}`;
        },
    },

    table: {
        filter: (node, _options, lookup) => node.nodeName === "TABLE" && !lookup.isRemoved(node),
        replacement: tableReplacement,
    },

    // A caption's text goes above its table, so it is kept for the table rule and written there.
    tableCaption: {
        filter: (node, _options, lookup) => node.nodeName === "CAPTION" && tableOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, node) {
            cellTexts.set(node, oneLine(content));

            return "";
        },
    },

    // A cell keeps its text for the table rule, which escapes its pipes when it writes the row.
    tableCell: {
        filter: (node, _options, lookup) => CELLS.has(node.nodeName) && tableOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, node) {
            cellTexts.set(node, oneLine(content));

            return "";
        },
    },

    // The table rule writes every row from the DOM.
    tableRow: {
        filter: (node, _options, lookup) => node.nodeName === "TR" && tableOf(node) !== null && !lookup.isRemoved(node),
        replacement: () => "",
    },

    tableSection: {
        filter: (node, _options, lookup) => ROW_GROUPS.has(node.nodeName) && tableOf(node) !== null && !lookup.isRemoved(node),
        replacement: () => "",
    },
};

const strikeAncestors = new WeakMap<Node, Element | null>();

/**
 * Literal tilde runs of two or more escaped, outside code spans: inside struck text they would end the strike. A single
 * tilde is left as it is, as in `~/path`.
 */
function escapeTildeRuns(markdown: string): string {
    let result = "";
    let index = 0;

    while (index < markdown.length) {
        const [text, end] = escapedToken(markdown, index);

        result += text;
        index = end;
    }

    return result;
}

/** The token that starts at `index`, as written, and where it ends: an escape, a code span, a tilde run or a character. */
function escapedToken(markdown: string, index: number): [text: string, end: number] {
    const char = markdown.charAt(index);

    if (char === "\\") {
        return [markdown.slice(index, index + 2), index + 2];
    }

    if (char === "`") {
        const fenceEnd = runEnd(markdown, index, "`");
        const close = closingFence(markdown, fenceEnd, fenceEnd - index);
        const end = close === -1 ? fenceEnd : close;

        return [markdown.slice(index, end), end];
    }

    if (char === "~") {
        const end = runEnd(markdown, index, "~");

        return [end - index >= 2 ? String.raw`\~`.repeat(end - index) : "~", end];
    }

    return [char, index + 1];
}

/** Where the run of `char` that starts at `start` ends. */
function runEnd(text: string, start: number, char: string): number {
    let end = start;

    while (text.charAt(end) === char) {
        end += 1;
    }

    return end;
}

/** The end of the backtick run of exactly `length` that closes a code span opened before `from`, or -1. */
function closingFence(text: string, from: number, length: number): number {
    let index = text.indexOf("`", from);

    while (index !== -1) {
        const end = runEnd(text, index, "`");

        if (end - index === length) {
            return end;
        }

        index = text.indexOf("`", end);
    }

    return -1;
}

const strikethrough: Rule = {
    filter: (node, _options, lookup) => STRIKE_NAMES.has(node.nodeName) && !lookup.isRemoved(node),
    replacement(content, node) {
        // A strike inside a strike is struck already: the outer element writes the one pair of tildes.
        if (nearestAncestor(node, STRIKE_NAMES, strikeAncestors)) {
            return content;
        }

        return content.trim() === "" ? content : `~~${escapeTildeRuns(content)}~~`;
    },
};

// A checkbox is a task list item's box. The type is matched without case, as HTML matches it.
const taskListItem: Rule = {
    filter: (node, _options, lookup) => node.nodeName === "INPUT" && (node.getAttribute("type") ?? "").toLowerCase() === "checkbox" && !lookup.isRemoved(node),
    replacement(_content, node) {
        // The current state, which a page may have changed since the markup set it; the attribute where there is none.
        const { checked } = node as Partial<HTMLInputElement>;
        const isChecked = typeof checked === "boolean" ? checked : node.hasAttribute("checked");

        return isChecked ? "[x] " : "[ ] ";
    },
};

/** Tables, strikethrough and task list items. */
export function gfm(service: TurndownService): void {
    service.addRule("strikethrough", strikethrough);
    service.addRule("taskListItem", taskListItem);

    for (const [key, rule] of Object.entries(tableRules)) {
        service.addRule(key, rule);
    }
}
