import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

const LINE_BREAK = /\r\n?|\n/;

/**
 * A copy from the composer puts one line break between its lines in `text/plain`, as the draft has them. With the
 * editor's default blank line, a cut and paste inside the draft (pasted line by line) would add an empty line each time.
 */
export const composerCoreExtensionOptions = { clipboardTextSerializer: { blockSeparator: "\n" } };

/**
 * The paste the editor would make of `text/plain`, but with every line kept: its own parser merges blank lines. With
 * `at` (a paste that waited for its conversion) it replaces the selection of `at`, and only while the text is unchanged
 * since: after an edit that selection is gone and the current one is the user's newer choice, so it returns false and
 * the caller places the text itself.
 */
export const pastePlainText = (editor: Editor, text: string, at?: EditorState): boolean => {
    const { schema, tr } = editor.state;
    const { paragraph } = schema.nodes;

    if (!paragraph) {
        return false;
    }

    if (at) {
        if (at.doc !== tr.doc) {
            return false;
        }

        tr.setSelection(at.selection);
    }

    const paragraphs = text.split(LINE_BREAK).map((line: string) => paragraph.create(null, line === "" ? null : schema.text(line)));
    const slice = new Slice(Fragment.from(paragraphs), 1, 1);

    // Its own undo step: a paste that finishes right after typing next to it would otherwise undo with that typing.
    editor.view.dispatch(closeHistory(tr).replaceSelection(slice).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));

    return true;
};
