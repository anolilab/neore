/**
 * GhostCompletion - inline autocomplete ("ghost text") after the caret.
 *
 * The suggestion is a widget decoration, so it is never part of the document:
 * `getText()` — and therefore the submitted message — cannot contain it. It
 * arrives through `setGhostCompletion` (from `ghost-completion-controller.ts`)
 * and disappears on ANY document or selection change.
 *
 * Right Arrow at the end of the line accepts, Escape dismisses. Not Tab: a
 * keyboard user tabbing out of the composer would instead take whatever the
 * model suggested, and a key that sometimes moves focus and sometimes edits is
 * a trap (WCAG 2.1.2). Right Arrow at the end of a line has nothing else to
 * do. Registered above the default priority so both keys reach it before
 * SubmitOnEnter / PromptHistoryKeys.
 */
import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface GhostCompletionState {
    /** Document position the ghost continues from. */
    pos: number;
    text: string;
}

export const ghostCompletionPluginKey = new PluginKey<GhostCompletionState | null>("ghostCompletion");

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        ghostCompletion: {
            /** Show `text` as ghost after the caret, or clear it with `null`. */
            setGhostCompletion: (text: string | null) => ReturnType;
        };
    }
}

/** The ghost currently shown, if any. */
export const getGhostCompletion = (state: EditorState): GhostCompletionState | null => ghostCompletionPluginKey.getState(state) ?? null;

/**
 * Whether Right Arrow accepts `ghost` in `state`: a collapsed caret exactly
 * where the ghost continues, at the end of its line — anywhere else the arrow
 * keeps moving the caret.
 */
export const canAcceptGhost = (state: EditorState, ghost: GhostCompletionState | null): ghost is GhostCompletionState => {
    const { $head, empty, head } = state.selection;

    return ghost !== null && empty && ghost.pos === head && $head.parentOffset === $head.parent.content.size;
};

const renderGhost = (text: string): HTMLElement => {
    const span = document.createElement("span");

    span.className = "composer-ghost-text pointer-events-none select-none text-muted-foreground/70";
    // Visual only: screen readers get one polite announcement from the editor
    // component instead of reading a suggestion that is not the user's text.
    span.setAttribute("aria-hidden", "true");
    span.dataset.ghostCompletion = "";
    span.contentEditable = "false";
    span.textContent = text;

    return span;
};

const GhostCompletion = Extension.create({
    addCommands() {
        return {
            setGhostCompletion:
                (text: string | null) =>
                ({ dispatch, state, tr }) => {
                    const current = getGhostCompletion(state);

                    if (text === null && current === null) {
                        return false;
                    }

                    if (dispatch) {
                        const value: GhostCompletionState | null = text === null ? null : { pos: state.selection.head, text };

                        tr.setMeta(ghostCompletionPluginKey, value);
                        // Not a text change: no `onUpdate` → store sync, no undo step.
                        tr.setMeta("preventUpdate", true);
                        tr.setMeta("addToHistory", false);
                        dispatch(tr);
                    }

                    return true;
                },
        };
    },

    addKeyboardShortcuts() {
        return {
            Escape: ({ editor }) => {
                if (!getGhostCompletion(editor.state)) {
                    return false;
                }

                return editor.commands.setGhostCompletion(null);
            },
            ArrowRight: ({ editor }) => {
                const ghost = getGhostCompletion(editor.state);

                if (!canAcceptGhost(editor.state, ghost)) {
                    return false;
                }

                const { tr } = editor.state;

                tr.insertText(ghost.text, ghost.pos);
                tr.setSelection(TextSelection.create(tr.doc, ghost.pos + ghost.text.length));
                tr.scrollIntoView();
                editor.view.dispatch(tr);

                return true;
            },
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin<GhostCompletionState | null>({
                key: ghostCompletionPluginKey,
                props: {
                    decorations(state) {
                        const ghost = ghostCompletionPluginKey.getState(state);

                        if (!ghost || ghost.pos > state.doc.content.size) {
                            return DecorationSet.empty;
                        }

                        return DecorationSet.create(state.doc, [
                            Decoration.widget(ghost.pos, () => renderGhost(ghost.text), { key: `ghost:${ghost.text}`, side: 1 }),
                        ]);
                    },
                },
                state: {
                    apply(tr, value) {
                        const meta = tr.getMeta(ghostCompletionPluginKey) as GhostCompletionState | null | undefined;

                        if (meta !== undefined) {
                            return meta;
                        }

                        // Typing, pasting, a caret move: the ghost belonged to the old state.
                        if (value && (tr.docChanged || tr.selectionSet)) {
                            return null;
                        }

                        return value;
                    },
                    init: () => null,
                },
            }),
        ];
    },

    name: "ghostCompletion",

    // Above the default (100) so Right Arrow/Escape reach it before the other key handlers.
    priority: 1000,
});

export default GhostCompletion;
