/**
 * Comment anchors in TipTap JSON.
 *
 * A comment is anchored by a `comment` MARK carrying `{ commentId }` on the text
 * it refers to (`apps/web/src/features/pages/lib/comment-mark.ts`). ProseMirror
 * maps marks through every edit, so ordinary typing keeps the anchor attached
 * without any help from here. What loses a mark is a wholesale content swap: a
 * version restore, a Page-agent rewrite from markdown, a paste over the range.
 *
 * {@link reconcileCommentAnchors} runs on every content write and decides, per
 * open root comment:
 *
 * - `anchored` — the mark is present; its current text becomes the new quote;
 * - `reanchored` — the mark is gone but the quote is still in the document, so
 *   the mark is re-applied on the first occurrence (within one block);
 * - `orphaned` — neither; the thread survives, shown as "text removed".
 *
 * A comment that was orphaned re-anchors on its own once its quote reappears
 * (an undo, a restore), because the same rule runs again.
 */

export const COMMENT_MARK = "comment";

interface TextNode {
    [key: string]: unknown;
    marks?: Mark[];
    text: string;
    type: "text";
}

interface Mark {
    attrs?: Record<string, unknown>;
    type: string;
}

interface JsonNode {
    [key: string]: unknown;
    content?: JsonNode[];
    marks?: Mark[];
    text?: string;
    type?: string;
}

const isTextNode = (node: JsonNode): node is JsonNode & TextNode => node.type === "text" && typeof node.text === "string";

const commentIdOf = (mark: Mark): string | undefined => {
    if (mark.type !== COMMENT_MARK) {
        return undefined;
    }

    const id = mark.attrs?.commentId;

    return typeof id === "string" && id.length > 0 ? id : undefined;
};

/**
 * Every comment id with a mark in `doc`, mapped to the text it covers. A mark
 * split by an edit into several runs yields their text joined in document order.
 */
export const collectCommentAnchors = (doc: unknown): Map<string, string> => {
    const anchors = new Map<string, string>();

    const walk = (node: JsonNode): void => {
        if (isTextNode(node)) {
            const marks = node.marks ?? [];

            for (const mark of marks) {
                const id = commentIdOf(mark);

                if (id) {
                    anchors.set(id, (anchors.get(id) ?? "") + node.text);
                }
            }
        }

        const children = node.content ?? [];

        for (const child of children) {
            walk(child);
        }
    };

    if (doc && typeof doc === "object") {
        walk(doc as JsonNode);
    }

    return anchors;
};

/**
 * A deep copy of `doc` without the comment marks `shouldRemove` picks (by
 * comment id). Other marks are untouched; a text node left with none loses its
 * `marks` key and joins equal neighbours, as ProseMirror would serialize it.
 */
export const removeCommentMarks = <T>(doc: T, shouldRemove: (commentId: string | undefined) => boolean): T => {
    const strip = (node: JsonNode): JsonNode => {
        const next: JsonNode = { ...node };

        if (node.marks) {
            const marks = node.marks.filter((mark) => mark.type !== COMMENT_MARK || !shouldRemove(commentIdOf(mark)));

            if (marks.length > 0) {
                next.marks = marks;
            } else {
                delete next.marks;
            }
        }

        if (node.content) {
            next.content = mergeTextRuns(node.content.map((child) => strip(child)));
        }

        return next;
    };

    if (!doc || typeof doc !== "object") {
        return doc;
    }

    return strip(doc as JsonNode) as T;
};

/**
 * Joins adjacent text nodes whose marks are equal — what ProseMirror does on
 * load, so a document with a mark removed serializes like one never marked.
 */
const mergeTextRuns = (children: JsonNode[]): JsonNode[] => {
    const merged: JsonNode[] = [];

    for (const child of children) {
        const previous = merged.at(-1);

        if (previous && isTextNode(previous) && isTextNode(child) && JSON.stringify(previous.marks ?? null) === JSON.stringify(child.marks ?? null)) {
            merged[merged.length - 1] = { ...previous, text: previous.text + child.text };
        } else {
            merged.push(child);
        }
    }

    return merged;
};

/** A deep copy of `doc` with every comment mark removed — for the public view and for comparing content. */
export const stripCommentMarks = <T>(doc: T): T => removeCommentMarks(doc, () => true);

/**
 * Applies a comment mark for `commentId` over the first occurrence of `quote`
 * inside a single block (a run of sibling text nodes). Returns the new document,
 * or `null` when the quote is nowhere to be found. Does not mutate `doc`.
 */
export const applyCommentMark = (doc: unknown, commentId: string, quote: string): unknown => {
    if (!doc || typeof doc !== "object" || quote.length === 0) {
        return null;
    }

    let applied = false;

    const visit = (node: JsonNode): JsonNode => {
        if (applied || !node.content) {
            return node;
        }

        const children = node.content;

        if (children.some((child) => isTextNode(child))) {
            const replaced = markInBlock(children, commentId, quote);

            if (replaced) {
                applied = true;

                return { ...node, content: replaced };
            }
        }

        return { ...node, content: children.map((child) => visit(child)) };
    };

    const next = visit(doc as JsonNode);

    return applied ? next : null;
};

/**
 * Within one block's children: concatenate runs of consecutive text nodes, find
 * `quote`, and split the covering nodes so exactly `[start, end)` carries the mark.
 */
const markInBlock = (children: JsonNode[], commentId: string, quote: string): JsonNode[] | null => {
    let runStart = 0;

    while (runStart < children.length) {
        if (!isTextNode(children[runStart] as JsonNode)) {
            runStart += 1;
            continue;
        }

        let runEnd = runStart;

        while (runEnd < children.length && isTextNode(children[runEnd] as JsonNode)) {
            runEnd += 1;
        }

        const run = children.slice(runStart, runEnd) as TextNode[];
        const text = run.map((node) => node.text).join("");
        const index = text.indexOf(quote);

        if (index !== -1) {
            const marked = splitAndMark(run, index, index + quote.length, commentId);

            return [...children.slice(0, runStart), ...marked, ...children.slice(runEnd)];
        }

        runStart = runEnd;
    }

    return null;
};

const splitAndMark = (run: TextNode[], start: number, end: number, commentId: string): JsonNode[] => {
    const result: JsonNode[] = [];
    let offset = 0;

    const piece = (node: TextNode, text: string, withMark: boolean): JsonNode => {
        const marks = [...(node.marks ?? [])];

        if (withMark) {
            marks.push({ attrs: { commentId }, type: COMMENT_MARK });
        }

        return marks.length > 0 ? { ...node, marks, text } : { ...node, text };
    };

    for (const node of run) {
        const nodeStart = offset;
        const nodeEnd = offset + node.text.length;

        offset = nodeEnd;

        if (nodeEnd <= start || nodeStart >= end) {
            result.push(node);
            continue;
        }

        const from = Math.max(start, nodeStart) - nodeStart;
        const to = Math.min(end, nodeEnd) - nodeStart;

        if (from > 0) {
            result.push(piece(node, node.text.slice(0, from), false));
        }

        result.push(piece(node, node.text.slice(from, to), true));

        if (to < node.text.length) {
            result.push(piece(node, node.text.slice(to), false));
        }
    }

    return result;
};

export interface AnchorInput {
    anchorText: string;
    commentId: string;
    orphaned: boolean;
}

export type AnchorOutcome =
    | { anchorText: string; commentId: string; kind: "anchored" }
    | { anchorText: string; commentId: string; kind: "reanchored" }
    | { commentId: string; kind: "orphaned" };

export interface ReconcileResult {
    /** The document with any re-applied marks — the same object when nothing was re-anchored. */
    doc: unknown;
    outcomes: AnchorOutcome[];
}

/** See the module comment. `comments` are the page's open ROOT comments. */
export const reconcileCommentAnchors = (doc: unknown, comments: ReadonlyArray<AnchorInput>): ReconcileResult => {
    const present = collectCommentAnchors(doc);
    const outcomes: AnchorOutcome[] = [];
    let current = doc;

    for (const comment of comments) {
        const covered = present.get(comment.commentId);

        if (covered !== undefined && covered.length > 0) {
            outcomes.push({ anchorText: covered, commentId: comment.commentId, kind: "anchored" });
            continue;
        }

        const next = comment.anchorText ? applyCommentMark(current, comment.commentId, comment.anchorText) : null;

        if (next) {
            current = next;
            outcomes.push({ anchorText: comment.anchorText, commentId: comment.commentId, kind: "reanchored" });
        } else {
            outcomes.push({ commentId: comment.commentId, kind: "orphaned" });
        }
    }

    return { doc: current, outcomes };
};

// ─── Comparison ──────────────────────────────────────────────────────────────

/**
 * Comment marks stripped, then adjacent text nodes with identical marks merged —
 * the form ProseMirror itself would produce. Without the merge, removing a mark
 * that split "ab|cd" leaves two nodes where the editor has one, and the same
 * text would compare unequal.
 */
const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) {
        return node.map((child) => normalize(child));
    }

    if (!node || typeof node !== "object") {
        return node;
    }

    const source = node as JsonNode;
    const result: Record<string, unknown> = {};

    const keys = Object.keys(source).toSorted((a, b) => a.localeCompare(b));

    for (const key of keys) {
        if (key === "content" || key === "marks") {
            continue;
        }

        result[key] = normalize(source[key]);
    }

    const marks = (source.marks ?? []).filter((mark) => mark.type !== COMMENT_MARK);

    if (marks.length > 0) {
        result.marks = normalize(marks);
    }

    if (source.content) {
        const merged: Record<string, unknown>[] = [];

        for (const entry of source.content) {
            const child = normalize(entry) as Record<string, unknown>;
            const previous = merged.at(-1);

            if (
                previous &&
                previous.type === "text" &&
                child.type === "text" &&
                JSON.stringify(previous.marks ?? null) === JSON.stringify(child.marks ?? null)
            ) {
                previous.text = String(previous.text) + String(child.text);
            } else {
                merged.push(child);
            }
        }

        result.content = merged;
    }

    return result;
};

/** Whether two documents differ in anything but comment marks. Key order does not matter. */
export const sameContentIgnoringComments = (a: unknown, b: unknown): boolean => JSON.stringify(normalize(a ?? null)) === JSON.stringify(normalize(b ?? null));
