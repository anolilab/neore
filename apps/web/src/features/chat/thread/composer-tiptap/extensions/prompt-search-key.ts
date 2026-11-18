/**
 * PromptSearchKey - Ctrl+R opens the search over the person's sent prompts (`composer-prompt-search.tsx`).
 *
 * Claims the key only while a handler is wired, so a composer without one keeps the browser's reload. Ctrl only: on a Mac
 * Cmd+R is reload too and stays with the browser. Vim normal mode leaves Ctrl chords alone (`vim-keys.ts`), so the key
 * reaches this extension there as well.
 */
import { Extension } from "@tiptap/core";

export interface PromptSearchKeyOptions {
    /** Opens the search. Returns `false` when nothing is listening, so the key is left to the browser. */
    onOpen: () => boolean;
}

const PromptSearchKey = Extension.create<PromptSearchKeyOptions>({
    addKeyboardShortcuts() {
        return {
            // ProseMirror calls preventDefault on a key a shortcut claims, which stops the browser's reload.
            "Ctrl-r": () => this.options.onOpen(),
        };
    },

    addOptions() {
        return {
            onOpen: () => false,
        };
    },

    name: "promptSearchKey",
});

export default PromptSearchKey;
