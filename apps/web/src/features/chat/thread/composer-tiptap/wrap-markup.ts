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
const LINK_TYPES: ReadonlySet<string> = new Set(["definition", "html", "image", "imageReference", "link", "linkReference"]);

/** Nodes whose content Markdown shows as typed. */
const CODE_TYPES: ReadonlySet<string> = new Set(["code", "inlineCode"]);

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
 * The longest draft that is parsed. Parsing a 10,000-character draft takes about 5 ms, and at most about 100 ms for a
 * paste built to be slow (thousands of unclosed `[x](`). A longer draft is not wrapped: typing replaces the selection.
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

const collect = (node: MarkdownNode, text: string, constructs: Construct[]): void => {
    const range = rangeOf(node);

    if (range !== undefined && (LINK_TYPES.has(node.type) || CODE_TYPES.has(node.type))) {
        constructs.push({ code: CODE_TYPES.has(node.type), holdable: node.type !== "definition", inner: labelOf(node, range, text), range });
    }

    const children = node.children ?? [];

    for (const child of children) {
        collect(child, text, constructs);
    }
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
 * remark, so links, images, references, definitions, autolinks, inline HTML and code are found with CommonMark's own
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

    const constructs: Construct[] = [];
    const { unmatched } = scanBackticks(text);

    collect(parser.parse(text) as MarkdownNode, text, constructs);

    return {
        blocked: constructs.some((construct) => breaks(construct, start + from, start + to)),
        paragraph: text.slice(start, start + parent.content.size),
        takenFences: new Set(unmatched.filter((run) => run.start < start + from).map((run) => run.length)),
    };
};
