/**
 * SubmitOnEnter - Tiptap extension for Enter-to-submit behavior
 *
 * Enter = submit (calls onSubmit callback)
 * Shift+Enter = new line (hard break)
 * Escape while streaming = cancel
 */
import { Extension } from "@tiptap/core";

export interface SubmitOnEnterOptions {
    isStreaming?: () => boolean;
    onCancel?: () => void;
    onSubmit: () => void;
}

const SubmitOnEnter = Extension.create<SubmitOnEnterOptions>({
    addKeyboardShortcuts() {
        return {
            Enter: () => {
                this.options.onSubmit();

                return true;
            },
            Escape: () => {
                if (this.options.isStreaming?.() && this.options.onCancel) {
                    this.options.onCancel();

                    return true;
                }

                return false;
            },
            "Shift-Enter": ({ editor }) => {
                editor.commands.setHardBreak();

                return true;
            },
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
