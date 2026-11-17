/**
 * EmojiShortcode - Tiptap extension that reports a `:shortcode` being typed before the caret.
 *
 * The rule is in ../emoji-shortcode/trigger. This only reads the caret's block and reports changes; the React side
 * (../use-emoji-shortcode) draws the list and replaces the text.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { findEmojiShortcodeQuery } from "../emoji-shortcode/trigger";

export interface EmojiShortcodeMatch {
    /** ProseMirror doc position of the colon. */
    from: number;
    /** Lower-cased text typed after the colon. */
    query: string;
    /** ProseMirror doc position of the caret, the end of the query. */
    to: number;
}

export interface EmojiShortcodeOptions {
    /** Called when a shortcode is detected, changes, or is no longer being typed. */
    onStateChange: (match: EmojiShortcodeMatch | null) => void;
}

const OBJECT_REPLACEMENT = "\u{FFFC}";

/** A hard break reads as the line break it shows, so a colon at the start of a wrapped line still counts. */
const leafText = (node: ProseMirrorNode): string => (node.type.name === "hardBreak" ? "\n" : OBJECT_REPLACEMENT);

/** The shortcode the caret is in, read from the caret's block; `null` when a selection is made or no shortcode is typed. */
export const readEmojiShortcodeMatch = (state: EditorState): EmojiShortcodeMatch | null => {
    const { selection } = state;

    if (!selection.empty) {
        return null;
    }

    const $pos = state.doc.resolve(selection.from);
    const found = findEmojiShortcodeQuery($pos.parent.textBetween(0, $pos.parentOffset, undefined, leafText));

    if (!found) {
        return null;
    }

    return { from: $pos.start() + found.startOffset, query: found.query, to: selection.from };
};

const sameMatch = (a: EmojiShortcodeMatch | null, b: EmojiShortcodeMatch | null): boolean =>
    a === b || (a !== null && b !== null && a.from === b.from && a.to === b.to && a.query === b.query);

const emojiShortcodePluginKey = new PluginKey("emojiShortcode");

const EmojiShortcode = Extension.create<EmojiShortcodeOptions>({
    addOptions() {
        return {
            onStateChange: () => {},
        };
    },

    addProseMirrorPlugins() {
        const extensionThis = this;
        let lastMatch: EmojiShortcodeMatch | null = null;

        return [
            new Plugin({
                key: emojiShortcodePluginKey,
                view() {
                    return {
                        destroy() {
                            lastMatch = null;
                        },
                        update(view) {
                            const next = readEmojiShortcodeMatch(view.state);

                            if (sameMatch(lastMatch, next)) {
                                return;
                            }

                            lastMatch = next;
                            extensionThis.options.onStateChange(next);
                        },
                    };
                },
            }),
        ];
    },

    name: "emojiShortcode",
});

export default EmojiShortcode;
