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
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

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

/**
 * Build a DecorationSet from banned word matches.
 * Maps character offsets (from the full text) to ProseMirror document positions.
 */
const buildDecorations = (document_: any, matches: BannedWordMatch[]): DecorationSet => {
    if (matches.length === 0) {
        return DecorationSet.empty;
    }

    const decorations: Decoration[] = [];

    // Build a mapping from text offset → doc position.
    // Walk the document and track cumulative text length.
    let textOffset = 0;
    const posMap: { docStart: number; textEnd: number; textStart: number }[] = [];

    document_.descendants((node: any, pos: number) => {
        if (node.isText) {
            posMap.push({
                docStart: pos,
                textEnd: textOffset + node.text.length,
                textStart: textOffset,
            });
            textOffset += node.text.length;
        } else if (node.isBlock && pos > 0) {
            // Block boundaries add a newline in getText()
            textOffset += 1; // newline separator
        }

        return true; // continue descending
    });

    for (const match of matches) {
        // Find the document positions for this match
        let from: number | null = null;
        let to: number | null = null;

        for (const segment of posMap) {
            // Check if match.startIndex falls in this segment
            if (from === null && match.startIndex >= segment.textStart && match.startIndex < segment.textEnd) {
                from = segment.docStart + (match.startIndex - segment.textStart);
            }

            // Check if match.endIndex falls in this segment
            if (to === null && match.endIndex > segment.textStart && match.endIndex <= segment.textEnd) {
                to = segment.docStart + (match.endIndex - segment.textStart);
            }

            if (from !== null && to !== null) {
                break;
            }
        }

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
                                decorations: buildDecorations(newState.doc, newMatches),
                                matches: newMatches,
                            };
                        }

                        // Doc changed (user typed) — rebuild decorations so they stay
                        // aligned with the current positions. Cleared automatically when
                        // the caller dispatches setBannedWordMatches([]).
                        if (tr.docChanged && oldPluginState.matches.length > 0) {
                            return {
                                decorations: buildDecorations(newState.doc, oldPluginState.matches),
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
