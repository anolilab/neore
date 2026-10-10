/**
 * FileMention - Tiptap extension for detecting @ file attachment triggers
 *
 * When the user types `@` followed by optional query text, this extension
 * emits state changes that the React popup component uses to show file
 * type suggestions. Selecting a file type triggers the file input dialog.
 *
 * The @ mention is purely a trigger - it doesn't create inline nodes.
 * Once a file is selected, the @ text is removed from the editor.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface FileMentionMatch {
    /** ProseMirror doc position where @ starts */
    from: number;
    query: string;
    /** ProseMirror doc position at cursor (end of query) */
    to: number;
}

export interface FileMentionOptions {
    /** Called when a @ mention is detected or dismissed */
    onStateChange: (match: FileMentionMatch | null) => void;
}

const fileMentionPluginKey = new PluginKey("fileMention");

// Hoisted RegExps to avoid re-creation on every keystroke (js-hoist-regexp)
const WHITESPACE_RE = /\s/;
const WORD_CHAR_RE = /\w/;

const FileMention = Extension.create<FileMentionOptions>({
    addOptions() {
        return {
            onStateChange: () => {},
        };
    },

    addProseMirrorPlugins() {
        const extensionThis = this;
        let lastMatch: FileMentionMatch | null = null;

        return [
            new Plugin({
                key: fileMentionPluginKey,
                view() {
                    return {
                        destroy() {
                            lastMatch = null;
                        },
                        update(view) {
                            const { state } = view;
                            const { selection } = state;

                            if (!selection.empty) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            const cursorPos = selection.from;

                            // Get the text content of the current text block up to cursor
                            const $pos = state.doc.resolve(cursorPos);
                            const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\u{FFFC}");

                            // Look for @ that's preceded by start-of-text or whitespace
                            let atIndex = -1;

                            for (let i = textBefore.length - 1; i >= 0; i -= 1) {
                                const char = textBefore[i];

                                if (char === "@") {
                                    if (i === 0 || WHITESPACE_RE.test(textBefore[i - 1]!)) {
                                        atIndex = i;
                                    }

                                    break;
                                }

                                // If we hit whitespace before finding @, stop
                                if (WHITESPACE_RE.test(char!)) {
                                    break;
                                }
                            }

                            if (atIndex === -1) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            const query = textBefore.slice(atIndex + 1);

                            // Don't trigger on email-like patterns (@ preceded by non-whitespace alphanumeric)
                            if (atIndex > 0 && WORD_CHAR_RE.test(textBefore[atIndex - 1]!)) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            // Map local text offset back to doc position
                            const blockStart = $pos.start();
                            const from = blockStart + atIndex;
                            const to = cursorPos;

                            const newMatch: FileMentionMatch = { from, query, to };

                            if (!lastMatch || lastMatch.query !== newMatch.query || lastMatch.from !== newMatch.from) {
                                lastMatch = newMatch;
                                extensionThis.options.onStateChange(newMatch);
                            }
                        },
                    };
                },
            }),
        ];
    },

    name: "fileMention",
});

export default FileMention;
