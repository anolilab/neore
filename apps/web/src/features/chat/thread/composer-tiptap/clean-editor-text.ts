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

    // One scan per textblock over the text of all its nodes: a selector or tag belongs to the character before it
    // even when that character sits in a node with other formatting. Anything that is not text (a hard break, a
    // mention) stands as a newline, which is no base for either.
    doc.descendants((block, blockPosition) => {
        if (!block.isTextblock) {
            return true;
        }

        const nodes: { docPosition: number; start: number }[] = [];
        let text = "";

        block.forEach((child, offset) => {
            if (child.isText && child.text !== undefined) {
                nodes.push({ docPosition: blockPosition + 1 + offset, start: text.length });
                text += child.text;
            } else {
                text += "\n";
            }
        });

        let at = 0;

        // The reported ranges come in order, so the node cursor only moves forward.
        for (const { index, length } of findHiddenText(text)) {
            while (at + 1 < nodes.length && (nodes[at + 1]?.start ?? Infinity) <= index) {
                at += 1;
            }

            const node = nodes[at];

            if (node) {
                const from = node.docPosition + (index - node.start);

                ranges.push({ from, to: from + length });
            }
        }

        return false;
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
