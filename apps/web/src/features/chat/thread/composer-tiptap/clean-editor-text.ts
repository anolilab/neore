import { stripHiddenText } from "@neore/ai/utils";
import type { Editor } from "@tiptap/core";

import { plainTextToHtml } from "./plain-text";

/**
 * The editor's text, with the hidden characters (`@neore/ai/utils`) taken out of the document itself, so what the
 * person sees, what the draft holds and what is sent are the same text. The replacement emits no update (the caller
 * is already inside one), so a character is counted once, by whoever reads `text` before this call.
 */
export const cleanEditorText = (editor: Editor): string => {
    const text = editor.getText({ blockSeparator: "\n" });
    const { removed, text: clean } = stripHiddenText(text);

    if (removed === 0) {
        return text;
    }

    const { from } = editor.state.selection;

    editor.commands.setContent(clean === "" ? "" : plainTextToHtml(clean), { emitUpdate: false });
    editor.commands.setTextSelection(Math.min(Math.max(from - removed, 1), editor.state.doc.content.size));

    return text;
};
