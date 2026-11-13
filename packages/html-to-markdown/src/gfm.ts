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

/**
 * The rows of the table itself, read from its children and row groups: a selector would list the rows of every table
 * nested in it too, once per table around them, which grows with the square of the nesting.
 */
function ownRows(table: Element, lookup: RuleLookup): Row[] {
    const groups: Element[][] = [];
    // Rows straight in the table form one group while no row group comes between them.
    let loose: Element[] | undefined;

    for (const child of childElements(table)) {
        if (isRemoved(child, lookup)) {
            continue;
        }

        if (child.nodeName === "TR") {
            if (!loose) {
                loose = [];
                groups.push(loose);
            }

            loose.push(child);
        } else if (ROW_GROUPS.has(child.nodeName)) {
            loose = undefined;
            groups.push(childElements(child).filter((row) => row.nodeName === "TR" && !isRemoved(row, lookup)));
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
    // For each column, how many more rows a cell above still covers.
    const covered: number[] = [];
    const lines: string[][] = [];
    let width = 0;

    for (const [rowIndex, { element: row, groupEnd }] of rows.entries()) {
        const line: string[] = [];
        let column = 0;
        const skipCovered = (): void => {
            while ((covered[column] ?? 0) > 0) {
                covered[column] = (covered[column] ?? 1) - 1;
                line[column] = "";
                column += 1;
            }
        };

        for (const cell of ownCells(row, lookup)) {
            skipCovered();

            const columns = span(cell, "colspan");
            const rowSpan = span(cell, "rowspan");
            const below = groupEnd - rowIndex - 1;

            width = Math.max(width, column + columns);

            if (width * rows.length > MAX_TABLE_CELLS) {
                return null;
            }

            line[column] = cellTexts.get(cell) ?? "";

            for (let offset = 0; offset < columns; offset += 1) {
                line[column + offset] ??= "";
                covered[column + offset] = rowSpan === 0 ? below : Math.min(rowSpan - 1, below);
            }

            column += columns;
        }

        while (column < covered.length) {
            skipCovered();
            column += 1;
        }

        lines.push(line);
    }

    return { lines, width };
}

function tableReplacement(_content: string, node: AnnotatedNode, _options: Options, lookup: RuleLookup): string {
    const rows = ownRows(node, lookup);

    // A table in a cell has no room for a grid: it is the text of its cells, inside the cell's line.
    if (cellOf(node)) {
        const texts = rows.flatMap(({ element }) => ownCells(element, lookup).map((cell) => cellTexts.get(cell) ?? ""));

        return ` ${texts.filter((text) => text !== "").join(" ")} `;
    }

    const caption = childElements(node).find((child) => child.nodeName === "CAPTION" && !isRemoved(child, lookup));
    const title = caption ? (cellTexts.get(caption) ?? "") : "";
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

    const line = (cells: ReadonlyArray<string>): string => `| ${Array.from({ length: width }, (_unused, index) => cells[index] ?? "").join(" | ")} |`;
    const [head = [], ...body] = lines;

    return `${before}${[line(head), `|${" --- |".repeat(width)}`, ...body.map((cells) => line(cells))].join("\n")}\n\n`;
}

const tableRules: Record<string, Rule> = {
    blockInCell: {
        filter: (node, _options, lookup) => BLOCKS_IN_CELL.has(node.nodeName) && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement: (content) => ` ${oneLine(content)} `,
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
    listInCell: {
        filter: (node, _options, lookup) => LISTS.has(node.nodeName) && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement: (content) => ` ${content.trim()} `,
    },

    listItemInCell: {
        filter: (node, _options, lookup) => node.nodeName === "LI" && cellOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, node) {
            const hasNextItem = Boolean(node.nextElementSibling && node.nextElementSibling.nodeName === "LI");

            return `${oneLine(content)}${hasNextItem ? "; " : ""}`;
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

    // A cell keeps its text for the table rule. GFM splits a row on every unescaped pipe, code spans included, so every
    // pipe is escaped.
    tableCell: {
        filter: (node, _options, lookup) => CELLS.has(node.nodeName) && tableOf(node) !== null && !lookup.isRemoved(node),
        replacement(content, node) {
            cellTexts.set(node, oneLine(content).replaceAll(PIPE, String.raw`\|`));

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

const STRIKE_NAMES = new Set(["DEL", "S", "STRIKE"]);

const strikethrough: Rule = {
    filter: (node, _options, lookup) => STRIKE_NAMES.has(node.nodeName) && !lookup.isRemoved(node),
    replacement(content) {
        return content.trim() === "" ? content : `~~${content}~~`;
    },
};

// A checkbox is a task list item's box. The type is matched without case, as HTML matches it.
const taskListItem: Rule = {
    filter: (node, _options, lookup) => node.nodeName === "INPUT" && (node.getAttribute("type") ?? "").toLowerCase() === "checkbox" && !lookup.isRemoved(node),
    replacement(_content, node) {
        return node.hasAttribute("checked") ? "[x] " : "[ ] ";
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
