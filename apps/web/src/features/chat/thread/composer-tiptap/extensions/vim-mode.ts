/**
 * VimMode - opt-in Vim keys for the composer (`userSettings.composerVimMode`).
 *
 * The key logic is `../vim-keys.ts`; this wires it to the editor. It runs before
 * every other key handler (priority), so in normal mode a letter never reaches the
 * text. While disabled it does nothing at all.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { VimMode as VimModeName, VimState } from "../vim-keys";
import { INITIAL_VIM_STATE, runVimKey } from "../vim-keys";

export interface VimModeOptions {
    isEnabled: () => boolean;
    /** A recalled prompt is showing: its Escape restores the draft, so insert-mode Escape must pass through. */
    isHistoryRecalled: () => boolean;
    onModeChange: (mode: VimModeName) => void;
}

const vimPluginKey = new PluginKey<VimState>("vimMode");

/**
 * Re-reads the plugin's attributes and decorations, and resets it to insert mode. The plugin only reads the setting on an
 * editor update, so a setting changed while the editor is open takes effect here rather than at the next keystroke.
 */
export const refreshVimMode = (view: EditorView): void => {
    view.dispatch(view.state.tr.setMeta(vimPluginKey, INITIAL_VIM_STATE));
};

const VimMode = Extension.create<VimModeOptions>({
    addOptions() {
        return {
            isEnabled: () => false,
            isHistoryRecalled: () => false,
            onModeChange: () => {},
        };
    },

    addProseMirrorPlugins() {
        const { options } = this;

        const modeOf = (state: Parameters<typeof vimPluginKey.getState>[0]): VimModeName =>
            options.isEnabled() ? (vimPluginKey.getState(state)?.mode ?? "insert") : "insert";

        return [
            new Plugin<VimState>({
                key: vimPluginKey,
                props: {
                    attributes: (state): Record<string, string> => (modeOf(state) === "normal" ? { class: "vim-normal" } : {}),
                    decorations: (state) => {
                        if (modeOf(state) !== "normal" || !state.selection.empty) {
                            return null;
                        }

                        const { $head } = state.selection;

                        // The block cursor: the character the next command acts on.
                        return $head.pos < $head.end()
                            ? DecorationSet.create(state.doc, [Decoration.inline($head.pos, $head.pos + 1, { class: "vim-cursor" })])
                            : null;
                    },
                    handleKeyDown: (view, event) => {
                        if (!options.isEnabled()) {
                            return false;
                        }

                        const vim = vimPluginKey.getState(view.state) ?? INITIAL_VIM_STATE;
                        const result = runVimKey(view.state, vim, event, options.isHistoryRecalled());

                        if (result.state !== vim || result.tr) {
                            view.dispatch((result.tr ?? view.state.tr).setMeta(vimPluginKey, result.state));
                        }

                        return result.handled;
                    },
                    // Soft keyboards and IME report no usable `key`: normal mode must not take their text either.
                    handleTextInput: (view) => modeOf(view.state) === "normal",
                },
                state: {
                    apply: (transaction, value) => transaction.getMeta(vimPluginKey) ?? value,
                    init: () => INITIAL_VIM_STATE,
                },
                view: () => {
                    let last: VimModeName | undefined;

                    return {
                        update: (view) => {
                            const mode = modeOf(view.state);

                            if (mode !== last) {
                                last = mode;
                                options.onModeChange(mode);
                            }
                        },
                    };
                },
            }),
        ];
    },

    name: "vimMode",

    priority: 1000,
});

export default VimMode;
