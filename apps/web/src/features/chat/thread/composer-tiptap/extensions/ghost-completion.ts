/**
 * GhostCompletion - inline autocomplete ("ghost text") after the caret.
 *
 * The suggestion is a widget decoration, so it is never part of the document:
 * `getText()` — and therefore the submitted message — cannot contain it. It
 * arrives through `setGhostCompletion` (from `ghost-completion-controller.ts`)
 * and disappears on ANY document or selection change.
 *
 * Right Arrow at the end of the line accepts, Escape dismisses. Not Tab for a
 * model's as-you-type completion: a keyboard user tabbing out of the composer
 * would instead take whatever the model suggested, and a key that sometimes
 * moves focus and sometimes edits is a trap (WCAG 2.1.2). Right Arrow at the
 * end of a line has nothing else to do. Registered above the default priority
 * so both keys reach it before SubmitOnEnter / PromptHistoryKeys.
 *
 * A suggested next prompt (`setSuggestedPrompt`, kind `prompt`) is a second
 * ghost source. Tab inserts it, as the composer spec asks, and the as-you-type
 * controller's clears (on focus, for instance) leave it alone.
 *
 * Accepted, the text is the model's, not the person's: `onAccept` runs once it is
 * in, and the composer marks its draft (`draft-origin.ts`).
 */
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface GhostCompletionState {
    /** `completion` (as-you-type, the default) or `prompt` (the suggested next prompt). */
    kind?: "completion" | "prompt";
    /** Document position the ghost continues from. */
    pos: number;
    text: string;
}

export const ghostCompletionPluginKey = new PluginKey<GhostCompletionState | null>("ghostCompletion");

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        ghostCompletion: {
            /** Dismiss whatever ghost is shown (Escape). */
            clearGhost: () => ReturnType;
            /** Show `text` as ghost after the caret, or clear it with `null`. A suggested prompt is not cleared by `null`. */
            setGhostCompletion: (text: string | null) => ReturnType;
            /** Show `text` as the suggested next prompt after the caret, or clear that one with `null`. */
            setSuggestedPrompt: (text: string | null) => ReturnType;
        };
    }
}

/** Right Arrow and Tab accept only where the caret is exactly at the ghost's end of line. */
const acceptGhost = (editor: Editor, ghost: GhostCompletionState): boolean => {
    const { tr } = editor.state;

    tr.insertText(ghost.text, ghost.pos);
    tr.setSelection(TextSelection.create(tr.doc, ghost.pos + ghost.text.length));
    tr.scrollIntoView();
    editor.view.dispatch(tr);

    return true;
};

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

export interface GhostCompletionOptions {
    /** Runs after an accepted ghost is in the document. */
    onAccept?: () => void;
}

/** Set or clear the ghost as meta: not a text change, so no `onUpdate` → store sync and no undo step. */
const setGhostMeta = (tr: EditorState["tr"], value: GhostCompletionState | null): void => {
    tr.setMeta(ghostCompletionPluginKey, value);
    tr.setMeta("preventUpdate", true);
    tr.setMeta("addToHistory", false);
};

const GhostCompletion = Extension.create<GhostCompletionOptions>({
    addOptions() {
        return { onAccept: undefined };
    },

    addCommands() {
        return {
            setGhostCompletion:
                (text: string | null) =>
                ({ dispatch, state, tr }) => {
                    const current = getGhostCompletion(state);

                    // The as-you-type controller clears what it asked for; a suggested prompt is not its to clear.
                    if (text === null && (current === null || current.kind === "prompt")) {
                        return false;
                    }

                    if (dispatch) {
                        setGhostMeta(tr, text === null ? null : { pos: state.selection.head, text });
                        dispatch(tr);
                    }

                    return true;
                },
            setSuggestedPrompt:
                (text: string | null) =>
                ({ dispatch, state, tr }) => {
                    const current = getGhostCompletion(state);

                    if (text === null && current?.kind !== "prompt") {
                        return false;
                    }

                    if (dispatch) {
                        setGhostMeta(tr, text === null ? null : { kind: "prompt", pos: state.selection.head, text });
                        dispatch(tr);
                    }

                    return true;
                },
            clearGhost:
                () =>
                ({ dispatch, state, tr }) => {
                    if (!getGhostCompletion(state)) {
                        return false;
                    }

                    if (dispatch) {
                        setGhostMeta(tr, null);
                        dispatch(tr);
                    }

                    return true;
                },
        };
    },

    addKeyboardShortcuts() {
        return {
            Escape: ({ editor }) => editor.commands.clearGhost(),
            ArrowRight: ({ editor }) => {
                const ghost = getGhostCompletion(editor.state);

                if (!canAcceptGhost(editor.state, ghost) || !acceptGhost(editor, ghost)) {
                    return false;
                }

                this.options.onAccept?.();

                return true;
            },
            Tab: ({ editor }) => {
                // Only the suggested prompt: a Tab with no prompt keeps its usual job of moving focus.
                const ghost = getGhostCompletion(editor.state);

                if (ghost?.kind !== "prompt" || !canAcceptGhost(editor.state, ghost) || !acceptGhost(editor, ghost)) {
                    return false;
                }

                this.options.onAccept?.();

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

                        // Typing, pasting, a caret move: the ghost belonged to the old state. A suggested prompt keeps its place
                        // while the caret stays where it was (a click into the empty composer), and goes on typing.
                        if (value && (tr.docChanged || (tr.selectionSet && (value.kind !== "prompt" || tr.selection.head !== value.pos)))) {
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
