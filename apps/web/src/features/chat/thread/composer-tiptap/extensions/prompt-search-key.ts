/**
 * PromptSearchKey - Ctrl+R opens the search over the person's sent prompts (`composer-prompt-search.tsx`).
 *
 * Claims the key only while a handler is wired, so a composer without one keeps the browser's reload. Ctrl only: on a Mac
 * Cmd+R is reload too and stays with the browser. Vim normal mode leaves Ctrl chords alone (`vim-keys.ts`), so the key
 * reaches this extension there as well.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface PromptSearchKeyOptions {
    /** Opens the search. Returns `false` when nothing is listening, so the key is left to the browser. */
    onOpen: () => boolean;
}

const LATIN_LETTER = /^[a-z]$/i;

/**
 * Ctrl+R, alone. The typed letter decides; the physical key in the R position counts only when the layout types no Latin
 * letter there (Cyrillic, Greek), where the browser's reload still answers it. On Dvorak or Colemak that key types `p`,
 * and Ctrl+P stays with whoever owns it.
 */
export const isPromptSearchKey = (event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">): boolean => {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return false;
    }

    if (LATIN_LETTER.test(event.key)) {
        return event.key.toLowerCase() === "r";
    }

    return event.code === "KeyR";
};

const PromptSearchKey = Extension.create<PromptSearchKeyOptions>({
    addOptions() {
        return {
            onOpen: () => false,
        };
    },

    addProseMirrorPlugins() {
        const { options } = this;

        return [
            new Plugin({
                key: new PluginKey("promptSearchKey"),
                props: {
                    handleKeyDown: (_view, event) => {
                        if (!isPromptSearchKey(event) || !options.onOpen()) {
                            return false;
                        }

                        // A taken key stops here: not the browser's reload, and not a shortcut someone recorded on Ctrl+R.
                        event.preventDefault();
                        event.stopPropagation();

                        return true;
                    },
                },
            }),
        ];
    },

    name: "promptSearchKey",
});

export default PromptSearchKey;
