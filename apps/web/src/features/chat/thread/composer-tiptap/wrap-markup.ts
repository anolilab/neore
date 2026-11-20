import { getTextSerializersFromSchema } from "@tiptap/core";
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

/** A list bullet or number and the spaces after it, matched at `lastIndex`. */
const LIST_MARKER = /[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)[ \t]*/y;

/** Heading `#`s and the spaces after them, matched at `lastIndex`. */
const HEADING_MARKER = /[ \t]{0,3}#{1,6}(?=[ \t]|$)[ \t]*/y;

/** A GFM task-list box (`[ ]`, `[x]`) and the spaces after it, matched at `lastIndex`. */
const TASK_MARKER = /\[[ x]\][ \t]+/iy;

/** The sticky marker patterns, by name. */
const MARKERS = { heading: HEADING_MARKER, list: LIST_MARKER, quote: QUOTE_MARKER, task: TASK_MARKER } as const;

/** The marker of kind `kind` at `offset` in `line`, or an empty string. */
const matchAt = (kind: keyof typeof MARKERS, line: string, offset: number): string => {
    MARKERS[kind].lastIndex = offset;

    return MARKERS[kind].exec(line)?.[0] ?? "";
};

/**
 * The length of the block markers at the start of `line`, nested ones included (`> - item`), read in one pass. A task
 * box (`[ ]`) is a marker only right after a list marker; after a heading or a quote it is text.
 */
const markerLength = (line: string): number => {
    let offset = 0;
    let afterList = false;

    for (;;) {
        const list = matchAt("list", line, offset);
        const marker = list || matchAt("quote", line, offset) || matchAt("heading", line, offset) || (afterList ? matchAt("task", line, offset) : "");

        if (marker === "") {
            return offset;
        }

        afterList = list !== "";
        offset += marker.length;
    }
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

/** `line` without the blockquote markers it starts with, so a table inside a quote reads as one. */
const withoutQuotes = (line: string): string => {
    let offset = 0;
    let marker = matchAt("quote", line, offset);

    while (marker !== "") {
        offset += marker.length;
        marker = matchAt("quote", line, offset);
    }

    return line.slice(offset);
};

/** The number of cells in a table row: GFM splits cells at every `|` that no odd run of backslashes escapes. */
const cellCount = (line: string): number => {
    const row = line.trim().replaceAll(OUTER_PIPES, "");
    let cells = 1;
    let backslashes = 0;

    for (const character of row) {
        if (character === "|" && backslashes % 2 === 0) {
            cells += 1;
        }

        backslashes = character === "\\" ? backslashes + 1 : 0;
    }

    return cells;
};

/** Whether `header` over `separator` starts a GFM table: a separator row under a line with as many cells. */
const headsTable = (header: string, separator: string): boolean => {
    const headerRow = withoutQuotes(header);
    const separatorRow = withoutQuotes(separator);

    return headerRow.trim() !== "" && isSeparatorRow(separatorRow) && cellCount(headerRow) === cellCount(separatorRow);
};

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
 * selection: a header row, a separator row under it with as many cells, and the rows after it up to a blank line.
 */
const breaksTable = (text: string, from: number, to: number): boolean => {
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const lineEndIndex = text.indexOf("\n", from);
    const line = lineFrom(text, lineStart);

    if (!line.includes("|")) {
        return false;
    }

    // Walk up the rows of this block to find a separator row under a header row: the table this line belongs to.
    let inTable = headsTable(line, lineFrom(text, lineEndIndex === -1 ? -1 : lineEndIndex + 1));
    let cursor = lineStart;
    let current = line;

    while (!inTable && cursor > 0 && current.trim() !== "") {
        const previousStart = text.lastIndexOf("\n", cursor - 2) + 1;
        const previous = text.slice(previousStart, cursor - 1);

        inTable = headsTable(previous, current);
        current = previous;
        cursor = previousStart;
    }

    return inTable && (isSeparatorRow(withoutQuotes(line)) || hasCellPipe(text, from, to));
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

/** A child of the selected textblock: its parent offset and size, and where its text starts and how long it is in the draft. */
interface ChildText {
    draftStart: number;
    length: number;
    offset: number;
    size: number;
}

/**
 * The draft as the composer sends it, read the way Tiptap's `getText` reads it (`readComposerText`): a line break before
 * every block after the first, a node's own text serialiser where it has one (a quote chip, a hard break) and nothing
 * inside it, and the text of text nodes. `toDraft` maps a parent offset in the textblock `parent` to its draft index;
 * a quote chip's text can hold Markdown the parse needs, such as a reference definition.
 */
const draftText = (doc: ProseMirrorNode, parent: ProseMirrorNode): { text: string; toDraft: (offset: number) => number } => {
    const serializers = getTextSerializersFromSchema(doc.type.schema);
    const range = { from: 0, to: doc.content.size };
    const children: ChildText[] = [];
    let parentPos = -1;
    let parentStart = 0;
    let text = "";

    doc.nodesBetween(range.from, range.to, (node, pos, nodeParent, index) => {
        if (node.isBlock && pos > range.from) {
            text += "\n";
        }

        if (node === parent) {
            parentPos = pos;
            parentStart = text.length;
        }

        const draftStart = text.length;
        const serialize = serializers[node.type.name];

        if (serialize) {
            text += nodeParent ? serialize({ index, node, parent: nodeParent, pos, range }) : "";
        } else if (node.isText) {
            text += node.text ?? "";
        }

        if (nodeParent === parent && parentPos !== -1) {
            children.push({ draftStart, length: text.length - draftStart, offset: pos - parentPos - 1, size: node.nodeSize });
        }

        return serialize === undefined;
    });

    const toDraft = (offset: number): number => {
        const child = children.find((candidate) => offset >= candidate.offset && offset < candidate.offset + candidate.size);

        if (child !== undefined) {
            return child.draftStart + Math.min(offset - child.offset, child.length);
        }

        const last = children.at(-1);

        return last === undefined ? parentStart : last.draftStart + last.length;
    };

    return { text, toDraft };
};

/** The textblock's text with a line break for each inline node that is not text, so its indices are parent offsets. */
const offsetText = (parent: ProseMirrorNode): string => {
    let text = "";

    parent.forEach((child) => {
        text += child.isText ? (child.text ?? "") : "\n";
    });

    return text;
};

/** A character reference (`&amp;`, `&#93;`, `&#x5D;`): a wrap inside one changes the character it stands for. */
const CHARACTER_REFERENCE = /&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][\da-z]{1,31});/gi;

/** A bare web address, which the GFM message renderer links although GFM is not parsed here. */
const BARE_WEB_ADDRESS = /(?:https?:\/\/|www\.)[^\s<]+/gi;

/** A character of an email address before its `@`, and one after it. */
const EMAIL_LOCAL = /[\w.+-]/;

const EMAIL_DOMAIN = /[\w.-]/;

/**
 * The bare email addresses in `text`, which GFM links too: each `@` grown to the address characters on either side, with
 * a dot in the domain. Found from each `@` rather than by a pattern, so a long word without one costs a single pass.
 */
const bareEmails = (text: string): [number, number][] => {
    const emails: [number, number][] = [];

    for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
        let start = at;
        let end = at + 1;

        while (start > 0 && EMAIL_LOCAL.test(text[start - 1] ?? "")) {
            start -= 1;
        }

        while (end < text.length && EMAIL_DOMAIN.test(text[end] ?? "")) {
            end += 1;
        }

        if (start < at && text.slice(at + 1, end).includes(".")) {
            emails.push([start, end]);
        }
    }

    return emails;
};

/** Punctuation GFM leaves out of the end of a bare link. */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(["!", '"', "'", ")", "*", ",", ".", ":", "?", "]", "_", "~"]);

/** The bare links in `text`, as constructs a wrap may hold whole but not split. */
const bareLinks = (text: string): Construct[] =>
    [...[...text.matchAll(BARE_WEB_ADDRESS)].map((match): [number, number] => [match.index, match.index + match[0].length]), ...bareEmails(text)].map(
        ([start, matchEnd]) => {
            const address = text.slice(start, matchEnd);
            // GFM keeps a closing parenthesis that a `(` inside the address balances (`.../Foo_(bar)`): the counts are
            // taken once, and each trimmed `)` lowers its own.
            let unbalanced = address.split(")").length - address.split("(").length;
            let end = matchEnd;

            while (end > start && TRAILING_PUNCTUATION.has(text[end - 1] ?? "") && (text[end - 1] !== ")" || unbalanced > 0)) {
                unbalanced -= text[end - 1] === ")" ? 1 : 0;
                end -= 1;
            }

            return { code: false, holdable: true, range: [start, end] };
        },
    );

/**
 * The bare links that start outside every parsed construct. An address that starts inside a link (its label or its
 * destination), an image, a definition, HTML or code is part of that construct, and GFM does not link it again; the
 * pattern may run on past the construct's end, so only where it starts counts.
 */
const bareLinksOutsideConstructs = (text: string, constructs: ReadonlyArray<Construct>): Construct[] =>
    bareLinks(text).filter((link) => constructs.every(({ range }) => link.range[0] < range[0] || link.range[0] >= range[1]));

/** The number of backslashes right before `index`. */
const trailingBackslashCount = (text: string, index: number): number => {
    let count = 0;

    while (count < index && text[index - count - 1] === "\\") {
        count += 1;
    }

    return count;
};

/** Names already checked: whether the parser decodes `&name;` to a character, as only known entity names do. */
const knownReferences = new Map<string, boolean>();

/** Whether `reference` stands for a character: numeric ones always do, named ones when the parser decodes them. */
const isCharacterReference = (reference: string): boolean => {
    if (reference.startsWith("&#")) {
        return true;
    }

    let known = knownReferences.get(reference);

    if (known === undefined) {
        const paragraph = parser.parse(reference).children?.[0] as (MarkdownNode & { children?: { value?: string }[] }) | undefined;

        known = paragraph?.children?.[0]?.value !== reference;
        knownReferences.set(reference, known);
    }

    return known;
};

/** The character references in `text` that no odd run of backslashes escapes, as constructs a wrap may hold whole. */
const characterReferences = (text: string): Construct[] =>
    [...text.matchAll(CHARACTER_REFERENCE)]
        .filter((match) => trailingBackslashCount(text, match.index) % 2 === 0 && isCharacterReference(match[0]))
        .map((match) => {
            return { code: false, holdable: true, range: [match.index, match.index + match[0].length] };
        });

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
    const { text, toDraft } = draftText(doc, parent);

    if (text.length > MAX_WRAP_DRAFT) {
        return null;
    }

    const { unmatched } = scanBackticks(text);
    const { blocks, constructs } = collect(parser.parse(text) as MarkdownNode, text);
    const paragraph = offsetText(parent);
    const draftFrom = toDraft(from);
    const draftTo = toDraft(to);
    // The line that holds the selection: a line break inside the textblock starts a new one, where block syntax can begin.
    const lineStart = from > 0 ? paragraph.lastIndexOf("\n", from - 1) + 1 : 0;
    const nextBreak = paragraph.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? paragraph.length : nextBreak;
    // A blockquote, list item or heading on this line keeps its marker only while the wrap starts after it.
    const onBlock = blocks.some(([blockStart, blockEnd]) => blockStart <= toDraft(lineEnd) && blockEnd >= toDraft(lineStart));
    const markers = onBlock ? lineStart + markerLength(paragraph.slice(lineStart, lineEnd)) : 0;

    return {
        blocked:
            from < markers ||
            breaksTable(text, draftFrom, draftTo) ||
            [...constructs, ...characterReferences(text), ...bareLinksOutsideConstructs(text, constructs)].some((construct) =>
                breaks(construct, draftFrom, draftTo),
            ),
        paragraph,
        takenFences: new Set(unmatched.filter((run) => run.start < draftFrom).map((run) => run.length)),
    };
};
