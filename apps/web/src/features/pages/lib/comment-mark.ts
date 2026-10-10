/**
 * The `comment` mark: anchors a page comment thread to a text range.
 *
 * `commentId` is the thread's id (`pageComments.commentId`). ProseMirror maps
 * marks through edits, so the anchor follows its text; when a wholesale content
 * swap drops it, the server re-anchors by quote (`backend/lunora/pages/
 * comment-anchors.ts`). The mark name and attribute are that module's contract.
 *
 * `excludes: ""` lets threads overlap; `inclusive: false` stops typing at the
 * end of a commented range from extending it.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { Mark, mergeAttributes } from "@tiptap/core";

export const COMMENT_MARK = "comment";

export const CommentMark = Mark.create({
    addAttributes() {
        return {
            commentId: {
                default: null,
                parseHTML: (element) => element.dataset.commentId,
                renderHTML: (attributes) => (attributes.commentId ? { "data-comment-id": String(attributes.commentId) } : {}),
            },
        };
    },
    excludes: "",
    inclusive: false,
    name: COMMENT_MARK,
    parseHTML() {
        return [{ tag: "span[data-comment-id]" }];
    },
    renderHTML({ HTMLAttributes }) {
        return [
            "span",
            mergeAttributes(HTMLAttributes, {
                class: "page-comment-anchor rounded-sm bg-amber-200/60 decoration-amber-500 underline-offset-2 dark:bg-amber-400/25",
            }),
            0,
        ];
    },
});

/** Every `[from, to)` range carrying the mark for `commentId`. */
export const findCommentRanges = (editor: Editor, commentId: string): { from: number; to: number }[] => {
    const ranges: { from: number; to: number }[] = [];

    editor.state.doc.descendants((node, pos) => {
        if (!(node.isText && node.marks.some((mark) => mark.type.name === COMMENT_MARK && mark.attrs.commentId === commentId))) {
            return;
        }

        const last = ranges.at(-1);

        if (last && last.to === pos) {
            last.to = pos + node.nodeSize;
        } else {
            ranges.push({ from: pos, to: pos + node.nodeSize });
        }
    });

    return ranges;
};

/** Applies the mark over the current selection. Returns the quoted text, or `null` for an empty selection. */
export const markSelection = (editor: Editor, commentId: string): string | null => {
    const { from, to } = editor.state.selection;

    if (from === to) {
        return null;
    }

    const quote = editor.state.doc.textBetween(from, to, " ").trim();

    if (!quote) {
        return null;
    }

    editor.chain().setMark(COMMENT_MARK, { commentId }).run();

    return quote;
};

/** Removes the mark for one thread, wherever it is. */
export const removeCommentMark = (editor: Editor, commentId: string): void => {
    const markType = editor.schema.marks[COMMENT_MARK];

    if (!markType) {
        return;
    }

    const ranges = findCommentRanges(editor, commentId);

    if (ranges.length === 0) {
        return;
    }

    const { tr } = editor.state;

    for (const range of ranges) {
        tr.removeMark(range.from, range.to, markType.create({ commentId }));
    }

    editor.view.dispatch(tr);
};

/** Selects and scrolls to a thread's anchor. Returns `false` when it has none (orphaned). */
export const focusCommentAnchor = (editor: Editor, commentId: string): boolean => {
    const [range] = findCommentRanges(editor, commentId);

    if (!range) {
        return false;
    }

    editor.chain().focus().setTextSelection(range).scrollIntoView().run();

    return true;
};

/** The comment id under the cursor, if any — lets a click in the text open its thread. */
export const commentIdAtSelection = (editor: Editor): string | null => {
    const mark = editor.state.selection.$from.marks().find((candidate) => candidate.type.name === COMMENT_MARK);

    return mark ? String(mark.attrs.commentId) : null;
};

/** A copy of `doc` without comment marks — for previews rendered with an editor that lacks the mark. */
export const stripCommentMarks = (doc: JSONContent): JSONContent => {
    const next: JSONContent = { ...doc };

    if (doc.marks) {
        const marks = doc.marks.filter((mark) => mark.type !== COMMENT_MARK);

        if (marks.length > 0) {
            next.marks = marks;
        } else {
            delete next.marks;
        }
    }

    if (doc.content) {
        next.content = doc.content.map((child) => stripCommentMarks(child));
    }

    return next;
};
