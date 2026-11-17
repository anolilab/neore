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

import { isOpenableShortcodeQuery, readEmojiShortcodeToken } from "../emoji-shortcode/trigger";

export interface EmojiShortcodeMatch {
    /** ProseMirror doc position of the colon. */
    from: number;
    /** Whether the list may open for it: the query is long enough. A shorter one is still reported, to keep a dismissal. */
    openable: boolean;
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

/**
 * What continues a shortcode after the caret: its characters, and the colon that closes a finished `:thumbsup:`. A caret
 * in front of either is not at the shortcode's end.
 */
const SHORTCODE_CHARACTER = /^[\w+:-]/;

/** Characters read before the caret: longer than any shortcode with its colon. */
const TEXT_WINDOW = 64;

/** A hard break reads as the line break it shows, so a colon at the start of a wrapped line still counts. */
const leafText = (node: ProseMirrorNode): string => (node.type.name === "hardBreak" ? "\n" : OBJECT_REPLACEMENT);

/** The shortcode the caret is in, read from the caret's block; `null` when a selection is made or no shortcode is typed. */
export const readEmojiShortcodeMatch = (state: EditorState): EmojiShortcodeMatch | null => {
    const { selection } = state;

    if (!selection.empty) {
        return null;
    }

    const $pos = state.doc.resolve(selection.from);
    // Only a window before the caret is read, so a long draft costs no more per keystroke than a short one. A window that
    // starts mid-block cannot see what precedes its first character, so a colon there is not taken.
    const windowStart = Math.max(0, $pos.parentOffset - TEXT_WINDOW);
    const found = readEmojiShortcodeToken($pos.parent.textBetween(windowStart, $pos.parentOffset, undefined, leafText));

    if (!found || (windowStart > 0 && found.startOffset === 0)) {
        return null;
    }

    // The caret must end the shortcode. Inside a longer `:word` the list would replace only the part before the caret.
    const after = $pos.parent.textBetween($pos.parentOffset, Math.min($pos.parentOffset + 1, $pos.parent.content.size), undefined, leafText);

    if (SHORTCODE_CHARACTER.test(after)) {
        return null;
    }

    return {
        from: $pos.start() + windowStart + found.startOffset,
        openable: isOpenableShortcodeQuery(found.query),
        query: found.query,
        to: selection.from,
    };
};

const sameMatch = (a: EmojiShortcodeMatch | null, b: EmojiShortcodeMatch | null): boolean =>
    a === b || (a !== null && b !== null && a.from === b.from && a.to === b.to && a.query === b.query && a.openable === b.openable);

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
