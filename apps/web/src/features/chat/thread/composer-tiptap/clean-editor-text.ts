import { findHiddenText } from "@neore/ai/utils";
import type { Editor } from "@tiptap/core";

/**
 * Takes the hidden characters (`@neore/ai/utils`) out of the editor's document itself, so what the person sees, what
 * the draft holds and what is sent are the same text. Only those characters are deleted, in place: spaces, tabs and
 * the caret stay exactly where they were (the selection is mapped through the deletions). The transaction emits no
 * update (the caller is already inside one), so a character is counted once, by whoever read the text before this call.
 */
export const cleanEditorText = (editor: Editor): void => {
    const { doc, tr } = editor.state;
    const ranges: { from: number; to: number }[] = [];

    doc.descendants((node, position) => {
        if (node.isText && node.text !== undefined) {
            for (const { index, length } of findHiddenText(node.text)) {
                ranges.push({ from: position + index, to: position + index + length });
            }
        }
    });

    if (ranges.length === 0) {
        return;
    }

    // From the end, so an earlier range keeps its position; the transaction maps the selection itself.
    // An index loop: `toReversed` is ES2023 and missing in browsers the ES2022 target supports.
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const range = ranges[index];

        if (range) {
            tr.delete(range.from, range.to);
        }
    }

    // Not undoable on its own: Undo must reverse the person's edit, not this cleanup.
    editor.view.dispatch(tr.setMeta("preventUpdate", true).setMeta("addToHistory", false));
};
