/**
 * VariableAutocomplete - Tiptap extension for detecting {{variable}} patterns
 *
 * Monitors the editor content for `{{` patterns and emits state changes
 * that the React popup component uses to show variable suggestions.
 *
 * Uses the same parsing logic as the original prompt-variables utility.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const VARIABLE_QUERY_RE = /^[\w.]*$/;

export interface VariableAutocompleteMatch {
    /** ProseMirror doc position where {{ starts */
    from: number;
    /** The query typed after {{ */
    query: string;
    /** ProseMirror doc position at cursor (end of query) */
    to: number;
}

export interface VariableAutocompleteOptions {
    /** Called when a variable pattern is detected or dismissed */
    onStateChange: (match: VariableAutocompleteMatch | null) => void;
}

const variablePluginKey = new PluginKey("variableAutocomplete");

const VariableAutocomplete = Extension.create<VariableAutocompleteOptions>({
    addOptions() {
        return {
            onStateChange: () => {},
        };
    },

    addProseMirrorPlugins() {
        const extensionThis = this;
        let lastMatch: VariableAutocompleteMatch | null = null;

        return [
            new Plugin({
                key: variablePluginKey,
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

                            // Get text content of the current block up to cursor
                            const $pos = state.doc.resolve(cursorPos);
                            const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\u{FFFC}");

                            // Find the last {{ before cursor
                            const lastOpenIndex = textBefore.lastIndexOf("{{");

                            if (lastOpenIndex === -1) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            // Check if there's a closing }} between {{ and cursor
                            const afterOpen = textBefore.slice(lastOpenIndex);

                            if (afterOpen.includes("}}")) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            // Extract the query (text after {{)
                            const query = afterOpen.slice(2);

                            // Only match if query contains valid variable characters
                            if (query && !VARIABLE_QUERY_RE.test(query)) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            // Map local text offset back to doc position
                            const blockStart = $pos.start();
                            const from = blockStart + lastOpenIndex;
                            const to = cursorPos;

                            const newMatch: VariableAutocompleteMatch = { from, query: query.toLowerCase(), to };

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

    name: "variableAutocomplete",
});

export default VariableAutocomplete;
