import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** The parts of a Markdown syntax tree this module reads. */
interface MarkdownNode {
    children?: MarkdownNode[];
    position?: { end: { offset?: number }; start: { offset?: number } };
    referenceType?: string;
    type: string;
}

/**
 * A piece of Markdown a wrap must keep whole, as `[start, end)` indices into the draft text. `inner` is the part a wrap
 * may sit inside: a link's label text. `code` constructs show their content literally, so an end inside one is refused.
 */
interface Construct {
    code: boolean;
    /** Whether a wrap may hold the whole construct. A definition may not: delimiters before it end its syntax. */
    holdable: boolean;
    inner?: [number, number];
    range: [number, number];
}

/** Link-like nodes: a delimiter inside their destination, label brackets or syntax changes or ends the link. */
const LINK_TYPES: ReadonlySet<string> = new Set(["definition", "html", "image", "imageReference", "link", "linkReference", "thematicBreak"]);

/** Containers whose `html` children are HTML blocks, which delimiters before them would turn into inline HTML. */
const BLOCK_PARENT_TYPES: ReadonlySet<string> = new Set(["blockquote", "listItem", "root"]);

/** Constructs a wrap may not hold whole: delimiters before them end their syntax (a definition, a code fence, a divider). */
const UNHOLDABLE_TYPES: ReadonlySet<string> = new Set(["code", "definition", "thematicBreak"]);

/** Nodes whose content Markdown shows as typed. */
const CODE_TYPES: ReadonlySet<string> = new Set(["code", "inlineCode"]);

/** Blocks whose marker sits at the start of a line: a wrap that starts there would move the marker into the text. */
const MARKED_BLOCK_TYPES: ReadonlySet<string> = new Set(["blockquote", "heading", "listItem"]);

/** A blockquote marker `>` and the space after it, matched at `lastIndex`. */
const QUOTE_MARKER = /[ \t]{0,3}>[ \t]?/y;

/** A list bullet or number, or heading `#`s, and the spaces after them, matched at `lastIndex`. */
const LIST_OR_HEADING_MARKER = /[ \t]{0,3}(?:[-+*]|\d{1,9}[.)]|#{1,6})(?=[ \t]|$)[ \t]*/y;

/** The block marker at `offset` in `line`, or an empty string. */
const markerAt = (line: string, offset: number): string => {
    QUOTE_MARKER.lastIndex = offset;
    LIST_OR_HEADING_MARKER.lastIndex = offset;

    return (QUOTE_MARKER.exec(line) ?? LIST_OR_HEADING_MARKER.exec(line))?.[0] ?? "";
};

/** The length of the block markers at the start of `line`, nested ones included (`> - item`), read in one pass. */
const markerLength = (line: string): number => {
    let offset = 0;
    let marker = markerAt(line, offset);

    while (marker !== "") {
        offset += marker.length;
        marker = markerAt(line, offset);
    }

    return offset;
};

const runLength = (text: string, start: number): number => {
    let end = start;

    while (end < text.length && text[end] === "`") {
        end += 1;
    }

    return end - start;
};

/**
 * A lookup of the next backtick run of an exact length at or after a position. The runs are found in one pass and each
 * length keeps a cursor that only moves forward, because the scan in `codeSpans` asks with rising positions: the whole
 * paragraph is read a bounded number of times, however many runs it has.
 */
const nextRunFinder = (text: string): ((start: number, length: number) => number) => {
    const runsByLength = new Map<number, number[]>();

    for (const run of text.matchAll(/`+/g)) {
        const starts = runsByLength.get(run[0].length) ?? [];

        starts.push(run.index);
        runsByLength.set(run[0].length, starts);
    }

    const cursors = new Map<number, number>();

    return (start, length) => {
        const starts = runsByLength.get(length) ?? [];
        let cursor = cursors.get(length) ?? 0;

        while (cursor < starts.length && (starts[cursor] ?? 0) < start) {
            cursor += 1;
        }

        cursors.set(length, cursor);

        return starts[cursor] ?? -1;
    };
};

/** A backtick run that no later run of the same length closes, so Markdown shows it as a literal backtick. */
interface UnmatchedRun {
    length: number;
    start: number;
}

/**
 * The inline code spans of `text`, as `[start, end)` indices, and the runs that open none. Markdown shows everything
 * inside a span literally. A backtick escaped by a backslash outside code does not open a span.
 */
export const scanBackticks = (text: string): { spans: [number, number][]; unmatched: UnmatchedRun[] } => {
    const findRun = nextRunFinder(text);
    const spans: [number, number][] = [];
    const unmatched: UnmatchedRun[] = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] === "\\") {
            index += 2;
        } else if (text[index] === "`") {
            const length = runLength(text, index);
            const closing = findRun(index + length, length);

            if (closing === -1) {
                unmatched.push({ length, start: index });
                index += length;
            } else {
                spans.push([index, closing + length]);
                index = closing + length;
            }
        } else {
            index += 1;
        }
    }

    return { spans, unmatched };
};

/**
 * Emphasis is not needed here, and its resolution is quadratic on drafts full of `*` and `_`, so it is turned off.
 * GFM is not loaded either: its extensions are quadratic on some pastes (a long run of `]`), and the only GFM construct
 * that matters here is the bare-URL autolink.
 */
const parser = unified()
    .use(remarkParse)
    .data("micromarkExtensions", [{ disable: { null: ["attention"] } }]);

/**
 * The longest draft that is parsed. Parsing a 10,000-character draft takes about 5 ms, and at most about 150 ms for a
 * paste built to be slow (thousands of nested `>` or unclosed `[x](`). A longer draft is not wrapped: typing replaces the selection.
 */
export const MAX_WRAP_DRAFT = 10_000;

const rangeOf = (node: MarkdownNode): [number, number] | undefined => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    return start === undefined || end === undefined ? undefined : [start, end];
};

/**
 * The label text of a `[label](...)` or `[label][ref]` link: the span of its children. An autolink's children are its
 * URL, and an image's alt text is not formatted, so neither has a part a wrap may sit inside.
 */
const labelOf = (node: MarkdownNode, range: [number, number], text: string): [number, number] | undefined => {
    // A shortcut or collapsed reference (`[docs]`, `[docs][]`) uses its text as the identifier, so a wrap there unlinks it.
    const fullReference = node.type === "linkReference" && node.referenceType === "full";

    if (text[range[0]] !== "[" || (!fullReference && node.type !== "link")) {
        return undefined;
    }

    const first = node.children?.[0];
    const last = node.children?.at(-1);
    const start = first === undefined ? range[0] + 1 : rangeOf(first)?.[0];
    const end = last === undefined ? range[0] + 1 : rangeOf(last)?.[1];

    return start === undefined || end === undefined ? undefined : [start, end];
};

/** The underline of a setext heading (`Title` over `===`): the line after its text, which a wrap would turn into text. */
const setextUnderline = (node: MarkdownNode, range: [number, number], text: string): [number, number] | undefined => {
    const textEnd = rangeOf(node.children?.at(-1) ?? node)?.[1] ?? range[1];
    const lineBreak = text.indexOf("\n", textEnd);

    return lineBreak === -1 || lineBreak >= range[1] ? undefined : [lineBreak + 1, range[1]];
};

/** The pipes at the two ends of a table row. */
const OUTER_PIPES = /^\||\|$/g;

/** A separator cell: dashes, with an optional colon at either end. */
const SEPARATOR_CELL = /^ *:?-+:? *$/;

/** Whether `line` is a GFM table separator row: cells of dashes, with optional colons, between pipes. */
const isSeparatorRow = (line: string): boolean =>
    line.includes("|") &&
    line
        .trim()
        .replaceAll(OUTER_PIPES, "")
        .split("|")
        .every((cell) => SEPARATOR_CELL.test(cell));

/** The line of `text` that starts at `start`, without its line break; empty when `start` is -1. */
const lineFrom = (text: string, start: number): string => {
    if (start === -1) {
        return "";
    }

    const end = text.indexOf("\n", start);

    return text.slice(start, end === -1 ? text.length : end);
};

/** Whether `from`..`to` holds a `|` that separates cells: one no odd run of backslashes escapes (`\\|` is cell text). */
const hasCellPipe = (text: string, from: number, to: number): boolean => {
    let backslashes = 0;

    for (let index = text.lastIndexOf("\n", from - 1) + 1; index < to; index += 1) {
        if (text[index] === "|" && index >= from && backslashes % 2 === 0) {
            return true;
        }

        backslashes = text[index] === "\\" ? backslashes + 1 : 0;
    }

    return false;
};

/**
 * Whether a wrap of `from`..`to` (draft indices) would break a GFM table, as the message renderer shows one: a wrap on
 * its separator row, or one across a cell's `|`. GFM is not parsed here, so the table is found from the lines around the
 * selection: a row with a `|`, a separator row under it, and the rows after it up to a blank line.
 */
const breaksTable = (text: string, from: number, to: number): boolean => {
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const lineEndIndex = text.indexOf("\n", from);
    const line = lineFrom(text, lineStart);

    if (!line.includes("|")) {
        return false;
    }

    // Walk up the rows of this block to find the separator row it hangs from, or the one right below a header row.
    let separator = false;
    let cursor = lineStart;
    let current = line;

    while (!separator && current.trim() !== "") {
        separator = isSeparatorRow(current);

        if (cursor === 0) {
            break;
        }

        const previousStart = text.lastIndexOf("\n", cursor - 2) + 1;

        current = text.slice(previousStart, cursor - 1);
        cursor = previousStart;
    }

    const inTable = separator || isSeparatorRow(lineFrom(text, lineEndIndex === -1 ? -1 : lineEndIndex + 1));

    return inTable && (isSeparatorRow(line) || hasCellPipe(text, from, to));
};

/**
 * The constructs and marked blocks of a syntax tree. An explicit stack walks it, because a deeply nested tree (thousands
 * of `>`) would overflow recursion.
 */
const collect = (root: MarkdownNode, text: string): { blocks: [number, number][]; constructs: Construct[] } => {
    const blocks: [number, number][] = [];
    const constructs: Construct[] = [];
    // Each pending node with its parent's type: an `html` node right under a block container is an HTML block.
    const pending: [MarkdownNode, string][] = [[root, ""]];
    let [node, parentType] = pending.pop() ?? [undefined, ""];

    while (node !== undefined) {
        const range = rangeOf(node);
        const htmlBlock = node.type === "html" && BLOCK_PARENT_TYPES.has(parentType);

        if (range !== undefined && MARKED_BLOCK_TYPES.has(node.type)) {
            blocks.push(range);
        }

        if (range !== undefined && (LINK_TYPES.has(node.type) || CODE_TYPES.has(node.type))) {
            // An inline code span shows its content literally; a code block also ends its fence syntax if anything is put
            // before it, so like a definition it may not be held whole.
            constructs.push({
                code: node.type === "inlineCode",
                holdable: !UNHOLDABLE_TYPES.has(node.type) && !htmlBlock,
                inner: labelOf(node, range, text),
                range,
            });
        }

        const underline = range === undefined || node.type !== "heading" ? undefined : setextUnderline(node, range, text);

        if (underline !== undefined) {
            constructs.push({ code: false, holdable: false, range: underline });
        }

        const { type } = node;

        pending.push(...(node.children ?? []).map((child): [MarkdownNode, string] => [child, type]));
        [node, parentType] = pending.pop() ?? [undefined, ""];
    }

    return { blocks, constructs };
};

/**
 * The draft as the composer sends it: its blocks joined by line breaks, with a line break for each inline node that is
 * not text. `start` is where the textblock `parent` begins in it; a parent offset `p` is at `start + p`, because every
 * character and every inline node takes one offset and one position.
 */
const draftText = (doc: ProseMirrorNode, parent: ProseMirrorNode): { start: number; text: string } => {
    let text = "";
    let start = 0;
    let first = true;

    doc.descendants((node) => {
        if (!node.isTextblock) {
            return true;
        }

        if (!first) {
            text += "\n";
        }

        first = false;

        if (node === parent) {
            start = text.length;
        }

        node.forEach((child) => {
            text += child.isText ? (child.text ?? "") : "\n";
        });

        return false;
    });

    return { start, text };
};

/**
 * Whether a wrap of `from`..`to` (indices into the draft text) would break a construct: an end strictly inside code,
 * or an overlap with a link-like construct that neither holds all of it nor sits inside its label text.
 */
const breaks = (construct: Construct, from: number, to: number): boolean => {
    const [start, end] = construct.range;

    if (construct.code) {
        return (from > start && from < end) || (to > start && to < end);
    }

    const overlaps = from < end && to > start;
    const holdsAll = construct.holdable && from <= start && to >= end;
    const insideLabel = construct.inner !== undefined && from >= construct.inner[0] && to <= construct.inner[1];

    return overlaps && !holdsAll && !insideLabel;
};

/**
 * The Markdown around a selection `from`..`to` in the textblock `parent` (parent offsets). The draft is parsed with
 * remark, so links, images, references, definitions, autolinks, inline HTML, code and block markers are found with CommonMark's own
 * rules. Returns `null` for a draft longer than `MAX_WRAP_DRAFT`. `blocked` is whether a wrap would break one of them; `paragraph` is the
 * textblock's text with a line break for each inline node that is not text, for the flanking checks. `takenFences` are
 * the lengths of unmatched backtick runs before the selection: a code fence of such a length would pair with that run.
 */
export const markupAround = (
    doc: ProseMirrorNode,
    parent: ProseMirrorNode,
    from: number,
    to: number,
): { blocked: boolean; paragraph: string; takenFences: ReadonlySet<number> } | null => {
    const { start, text } = draftText(doc, parent);

    if (text.length > MAX_WRAP_DRAFT) {
        return null;
    }

    const { unmatched } = scanBackticks(text);

    const { blocks, constructs } = collect(parser.parse(text) as MarkdownNode, text);

    const paragraph = text.slice(start, start + parent.content.size);
    // The line that holds the selection: a line break inside the textblock starts a new one, where block syntax can begin.
    const lineStart = from > 0 ? paragraph.lastIndexOf("\n", from - 1) + 1 : 0;
    const nextBreak = paragraph.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? paragraph.length : nextBreak;
    // A blockquote, list item or heading on this line keeps its marker only while the wrap starts after it.
    const onBlock = blocks.some(([blockStart, blockEnd]) => blockStart <= start + lineEnd && blockEnd >= start + lineStart);
    const markers = onBlock ? lineStart + markerLength(paragraph.slice(lineStart, lineEnd)) : 0;

    return {
        blocked: from < markers || breaksTable(text, start + from, start + to) || constructs.some((construct) => breaks(construct, start + from, start + to)),
        paragraph,
        takenFences: new Set(unmatched.filter((run) => run.start < start + from).map((run) => run.length)),
    };
};
