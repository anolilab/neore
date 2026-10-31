/**
 * SubmitOnEnter - Tiptap extension for Enter-to-submit behavior
 *
 * Which chord sends is the user's `sendBehavior` preference (see ../send-behavior); Cmd/Ctrl+Enter always sends.
 * Escape while streaming = cancel
 */
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { EnterChord } from "../send-behavior";
import { resolveEnterAction } from "../send-behavior";

export interface SubmitOnEnterOptions {
    isStreaming?: () => boolean;
    onCancel?: () => void;
    onSubmit: () => void;
}

const SubmitOnEnter = Extension.create<SubmitOnEnterOptions>({
    addKeyboardShortcuts() {
        const handleEnter = (editor: Editor, chord: EnterChord): boolean => {
            // An IME confirming a candidate also reports Enter; it must not send.
            if (editor.view.composing) {
                return false;
            }

            if (resolveEnterAction(useUIStateStore.getState().preferences.sendBehavior, chord) === "send") {
                this.options.onSubmit();
            } else {
                editor.commands.setHardBreak();
            }

            return true;
        };

        return {
            Enter: ({ editor }) => handleEnter(editor, "plain"),
            Escape: () => {
                if (this.options.isStreaming?.() && this.options.onCancel) {
                    this.options.onCancel();

                    return true;
                }

                return false;
            },
            "Mod-Enter": ({ editor }) => handleEnter(editor, "mod"),
            "Shift-Enter": ({ editor }) => handleEnter(editor, "shift"),
        };
    },

    addOptions() {
        return {
            isStreaming: () => false,
            onCancel: undefined,
            onSubmit: () => {},
        };
    },

    name: "submitOnEnter",
});

export default SubmitOnEnter;
