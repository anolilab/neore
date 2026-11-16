/**
 * BannedWordDecoration - Tiptap extension for highlighting banned words
 *
 * Uses ProseMirror Decorations to add visual highlighting to banned words
 * directly in the editor (no overlay needed). The decorations are purely
 * visual and don't modify the document model.
 *
 * Matches are communicated via a typed transaction meta key (not options
 * mutation) so the plugin state is always consistent with the document.
 */
import { Extension, getTextSerializersFromSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type TextSerializers = ReturnType<typeof getTextSerializersFromSchema>;

export interface BannedWordMatch {
    endIndex: number;
    startIndex: number;
    word: string;
}

/**
 * No options: matches used to arrive here, and now arrive as plugin state via
 * the `setBannedWordMatches` command instead. Kept as a named type so the
 * extension's generic stays self-documenting.
 */
export type BannedWordDecorationOptions = Record<string, never>;

// Typed plugin key — the state stores the current DecorationSet and the
// raw matches so they can be rebuilt when the document changes.
interface BannedWordPluginState {
    decorations: DecorationSet;
    matches: BannedWordMatch[];
}

export const bannedWordPluginKey = new PluginKey<BannedWordPluginState>("bannedWordDecoration");

// Extend tiptap's Commands interface so editor.commands.setBannedWordMatches
// is fully type-safe.
declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        bannedWordDecoration: {
            setBannedWordMatches: (matches: BannedWordMatch[]) => ReturnType;
        };
    }
}

/** The separator the composer reads its draft with (`editor.getText({ blockSeparator: "\n" })`). */
const BLOCK_SEPARATOR = "\n";

/** A stretch of the draft text: editable text (a text node) or a serialised leaf such as a quote chip. */
interface TextSegment {
    docStart: number;
    /** A leaf rendered as text (a chip): its text is in the draft, but the editor cannot mark it. */
    opaque: boolean;
    textEnd: number;
    textStart: number;
}

/**
 * Walks the document exactly as Tiptap's `getText` does (`getTextBetween`), so a match's offset in the draft lands on
 * the same character in the editor: every block after the first adds a separator, a node with a text serialiser
 * (`renderText`, a quote chip) contributes its serialised text and is not descended into, and text nodes contribute
 * their text. The serialised text is what the original walk left out, which pushed later matches off their words.
 */
const buildSegments = (document_: ProseMirrorNode, serializers: TextSerializers): TextSegment[] => {
    const segments: TextSegment[] = [];
    const range = { from: 0, to: document_.content.size };
    let textOffset = 0;

    document_.nodesBetween(range.from, range.to, (node, pos, parent, index) => {
        if (node.isBlock && pos > range.from) {
            textOffset += BLOCK_SEPARATOR.length;
        }

        const serialize = serializers[node.type.name];

        if (serialize) {
            const text = parent ? serialize({ index, node, parent, pos, range }) : "";

            segments.push({ docStart: pos, opaque: true, textEnd: textOffset + text.length, textStart: textOffset });
            textOffset += text.length;

            return false;
        }

        if (node.isText) {
            const { length } = node.text ?? "";

            segments.push({ docStart: pos, opaque: false, textEnd: textOffset + length, textStart: textOffset });
            textOffset += length;
        }

        return true;
    });

    return segments;
};

/** The document position of a draft offset, or null when it falls in a chip or outside the text. */
const positionOf = (segments: TextSegment[], index: number, isEnd: boolean): number | null => {
    for (const segment of segments) {
        const inside = isEnd ? index > segment.textStart && index <= segment.textEnd : index >= segment.textStart && index < segment.textEnd;

        if (inside) {
            return segment.opaque ? null : segment.docStart + (index - segment.textStart);
        }
    }

    return null;
};

/**
 * Build a DecorationSet from banned word matches.
 * Maps character offsets (from the full text) to ProseMirror document positions.
 */
const buildDecorations = (document_: ProseMirrorNode, matches: BannedWordMatch[], serializers: TextSerializers): DecorationSet => {
    if (matches.length === 0) {
        return DecorationSet.empty;
    }

    const segments = buildSegments(document_, serializers);
    const decorations: Decoration[] = [];

    for (const match of matches) {
        const from = positionOf(segments, match.startIndex, false);
        const to = positionOf(segments, match.endIndex, true);

        if (from !== null && to !== null && from < to) {
            decorations.push(
                Decoration.inline(from, to, {
                    class: "composer-banned-word",
                    style: "background-color: rgba(239, 68, 68, 0.3); border-radius: 2px;",
                }),
            );
        }
    }

    return DecorationSet.create(document_, decorations);
};

const BannedWordDecoration = Extension.create<BannedWordDecorationOptions>({
    addOptions() {
        return {};
    },

    addCommands() {
        return {
            setBannedWordMatches:
                (matches: BannedWordMatch[]) =>
                ({ dispatch, tr }) => {
                    if (dispatch) {
                        tr.setMeta(bannedWordPluginKey, matches);
                        // Suppress tiptap's onUpdate event so the decoration transaction
                        // doesn't trigger handleTextChange → setComposerBannedContent(null).
                        tr.setMeta("preventUpdate", true);
                        dispatch(tr);
                    }

                    return true;
                },
        };
    },

    addProseMirrorPlugins() {
        // The serialisers `getText` uses, so the offsets computed from the draft text match the document.
        const serializers = getTextSerializersFromSchema(this.editor.schema);

        return [
            new Plugin({
                key: bannedWordPluginKey,
                props: {
                    decorations(state) {
                        return bannedWordPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
                    },
                },
                state: {
                    apply(tr, oldPluginState, _oldEditorState, newState) {
                        // New matches dispatched via setBannedWordMatches command
                        const newMatches = tr.getMeta(bannedWordPluginKey) as BannedWordMatch[] | undefined;

                        if (newMatches !== undefined) {
                            return {
                                decorations: buildDecorations(newState.doc, newMatches, serializers),
                                matches: newMatches,
                            };
                        }

                        // Doc changed (user typed) — rebuild decorations so they stay
                        // aligned with the current positions. Cleared automatically when
                        // the caller dispatches setBannedWordMatches([]).
                        if (tr.docChanged && oldPluginState.matches.length > 0) {
                            return {
                                decorations: buildDecorations(newState.doc, oldPluginState.matches, serializers),
                                matches: oldPluginState.matches,
                            };
                        }

                        return oldPluginState;
                    },
                    init(): BannedWordPluginState {
                        // Annotated: a bare `matches: []` infers `never[]`, which then
                        // conflicts with the `BannedWordMatch[]` that `apply` returns.
                        return { decorations: DecorationSet.empty, matches: [] };
                    },
                },
            }),
        ];
    },

    name: "bannedWordDecoration",
});

export default BannedWordDecoration;
