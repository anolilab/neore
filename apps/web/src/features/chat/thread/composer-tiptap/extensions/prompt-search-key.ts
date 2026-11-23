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

/**
 * Ctrl+R, alone. The physical key counts as well as the typed letter: on a non-Latin layout (Cyrillic, Greek) the key
 * in the R position types another letter, and the browser's reload still answers it there.
 */
export const isPromptSearchKey = (event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">): boolean =>
    event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (event.key.toLowerCase() === "r" || event.code === "KeyR");

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
