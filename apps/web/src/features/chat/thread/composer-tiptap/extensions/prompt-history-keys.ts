/**
 * PromptHistoryKeys - ArrowUp/ArrowDown/Escape recall of previous prompts.
 *
 * Only claims a key when it cannot mean anything else:
 * - ArrowUp with a collapsed cursor at the very start of the document;
 * - ArrowDown with a collapsed cursor at the very end;
 * - Escape, only while a recalled entry is showing.
 * Everywhere else the key falls through, so moving between lines of a
 * multi-line draft is untouched. Open suggestion popups (slash, @, {{) are
 * checked by the `onNavigate` owner, which answers `null` to decline.
 *
 * Registered BEFORE SubmitOnEnter so Escape restores the draft before it can
 * cancel a running stream.
 */
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";

import type { PromptHistoryDirection } from "@/features/chat/core/utils/prompt-history";

import { plainTextToHtml } from "../plain-text";

export interface PromptHistoryKeysOptions {
    /** Returns the text to show, or `null` to let the key through. */
    onNavigate: (direction: PromptHistoryDirection) => string | null;
}

const isCollapsedAt = (editor: Editor, edge: "end" | "start"): boolean => {
    const { doc, selection } = editor.state;

    if (!selection.empty) {
        return false;
    }

    // Text positions run from 1 (inside the first paragraph) to size - 1.
    return edge === "start" ? selection.from <= 1 : selection.to >= doc.content.size - 1;
};

const show = (editor: Editor, text: string, cursor: "end" | "start"): void => {
    // emitUpdate so the composer store (and `onChange`) see the recalled text.
    editor
        .chain()
        .setContent(text ? plainTextToHtml(text) : "", { emitUpdate: true })
        .focus(cursor)
        .run();
};

const PromptHistoryKeys = Extension.create<PromptHistoryKeysOptions>({
    addKeyboardShortcuts() {
        const navigate = (editor: Editor, direction: PromptHistoryDirection, cursor: "end" | "start"): boolean => {
            const text = this.options.onNavigate(direction);

            if (text === null) {
                return false;
            }

            show(editor, text, cursor);

            return true;
        };

        return {
            // Up leaves the cursor at the start so the next Up keeps walking back;
            // Down leaves it at the end for the same reason.
            ArrowDown: ({ editor }) => isCollapsedAt(editor, "end") && navigate(editor, "down", "end"),
            ArrowUp: ({ editor }) => isCollapsedAt(editor, "start") && navigate(editor, "up", "start"),
            Escape: ({ editor }) => navigate(editor, "escape", "end"),
        };
    },

    addOptions() {
        return {
            onNavigate: () => null,
        };
    },

    name: "promptHistoryKeys",
});

export default PromptHistoryKeys;
