/**
 * SlashCommand - Tiptap extension for detecting slash commands
 *
 * Monitors the editor content for `/command` patterns and emits
 * state changes that the React popup component uses to show suggestions.
 *
 * The slash command is detected at the cursor position:
 * - Must start at the beginning of a line or after whitespace
 * - Matches: /command or /command query
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface SlashCommandMatch {
    command: "clear" | "compact" | "model" | "prompt" | "skill" | undefined;
    /** Range in ProseMirror doc positions for the full slash text */
    from: number;
    query: string;
    /** Character offset in the text where the slash starts */
    startOffset: number;
    /** The slash text as typed (`/c`, `/clear`): two drafts with the same command, query and range can still differ in it. */
    text: string;
    to: number;

    /**
     * Whether the whole draft is this slash text (a partial `/c` included): `/compact` and `/clear` only count as commands,
     * and the menu only runs them, when they are the entire message.
     */
    wholeDraft: boolean;
}

export interface SlashCommandOptions {
    /** Called when a slash command is detected or dismissed */
    onStateChange: (match: SlashCommandMatch | null) => void;
}

/**
 * Whether `match` is a bare `command` (`/compact`, `/clear`), the only form the menu runs. These take no argument: with
 * text after them, the composer sends that text as a message, as submitting it directly does.
 */
export const isBareCommand = (match: Pick<SlashCommandMatch, "command" | "query" | "wholeDraft">, command: "clear" | "compact"): boolean =>
    match.command === command && match.query === "" && match.wholeDraft;

/** Whether the slash text from `slashStartOffset` to `slashEndOffset` is the whole of `fullText`, around blank space. */
export const isWholeDraft = (fullText: string, slashStartOffset: number, slashEndOffset: number): boolean =>
    slashStartOffset === 0 && fullText.trim() === fullText.slice(0, slashEndOffset).trim();

/** A slash match with the thread whose composer holds it. */
export interface ComposerSlashState {
    match: SlashCommandMatch | null;
    threadId: string | undefined;
}

/**
 * Where a finished `/clear` is removed from the draft: the range the menu ran it from, while the same thread's composer
 * still holds that same standalone text. `draft` is the editor's whole text read when the clear finished, so a keystroke
 * the menu has not been told of yet counts too. `null` once the draft changed or another thread is shown, so nothing
 * typed meanwhile, and no other chat's draft, is cut.
 */
export const clearedCommandRange = (selected: ComposerSlashState, now: ComposerSlashState & { draft: string }): { from: number; to: number } | null => {
    const was = selected.match;
    const is = now.match;
    const sameDraft = was !== null && now.draft.trim().toLowerCase() === was.text.trim().toLowerCase();

    return was && is?.wholeDraft === true && sameDraft && now.threadId === selected.threadId && is.text === was.text && is.from === was.from && is.to === was.to
        ? { from: is.from, to: is.to }
        : null;
};

/** Whether the slash text typed so far (`/c`, `/cle`) can be the start of `/command`: Clear is not run from `/m`. */
export const isPrefixOfCommand = (typed: string, command: "clear" | "compact"): boolean => `/${command}`.startsWith(typed.trim().toLowerCase());

/** Whether `match` is a bare `/compact`. */
export const isBareCompact = (match: Pick<SlashCommandMatch, "command" | "query" | "wholeDraft">): boolean => isBareCommand(match, "compact");

/**
 * The draft-text length a non-text node adds, as `doc.textBetween(…, "\n")` counts it: a line break before each block after
 * the first, and a leaf's own text (a quote chip's quoted lines), so offsets after a chip line up with the draft.
 */
export const nonTextLength = (node: ProseMirrorNode, pos: number): number =>
    (node.isBlock && pos > 0 ? 1 : 0) + (node.isLeaf ? (node.type.spec.leafText?.(node).length ?? 0) : 0);

const slashCommandPluginKey = new PluginKey("slashCommand");

const KNOWN_COMMANDS = ["clear", "compact", "model", "prompt", "skill"] as const;

// Hoisted RegExp to avoid re-creation on every keystroke (js-hoist-regexp)
const WHITESPACE_RE = /\s/;

/**
 * Parse a slash command from text before the cursor.
 * Returns the match info or null if no slash command is active.
 */
const parseSlashAtCursor = (
    text: string,
    cursorTextOffset: number,
): { command: SlashCommandMatch["command"]; query: string; slashEndOffset: number; slashStartOffset: number } | null => {
    // Look backwards from cursor to find a `/` preceded by start-of-text or whitespace
    let slashIndex = -1;

    for (let i = cursorTextOffset - 1; i >= 0; i -= 1) {
        const char = text[i];

        if (char === "/") {
            // Valid if at start or preceded by whitespace/newline
            if (i === 0 || WHITESPACE_RE.test(text[i - 1]!)) {
                slashIndex = i;
            }

            break;
        }
        // Stop if we hit whitespace before finding a slash (except for the command query part)
        // We allow spaces in the query part (e.g., /model gpt-4)
    }

    if (slashIndex === -1) {
        return null;
    }

    const afterSlash = text.slice(slashIndex + 1, cursorTextOffset);

    // Don't match if the text after slash contains a newline
    if (afterSlash.includes("\n")) {
        return null;
    }

    // Parse command and query
    const spaceIndex = afterSlash.indexOf(" ");
    const commandText = spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
    const query = spaceIndex === -1 ? "" : afterSlash.slice(spaceIndex + 1);

    // Check if it's a known command
    const lowerCommand = commandText.toLowerCase();
    const matchedCommand = KNOWN_COMMANDS.find((command) => command === lowerCommand);

    if (matchedCommand) {
        return {
            command: matchedCommand,
            query: query.trim(),
            slashEndOffset: cursorTextOffset,
            slashStartOffset: slashIndex,
        };
    }

    // Check if it's a partial command or just `/`
    if (commandText === "" || KNOWN_COMMANDS.some((command) => command.startsWith(lowerCommand))) {
        return {
            command: undefined,
            query: "",
            slashEndOffset: cursorTextOffset,
            slashStartOffset: slashIndex,
        };
    }

    return null;
};

const SlashCommand = Extension.create<SlashCommandOptions>({
    addOptions() {
        return {
            onStateChange: () => {},
        };
    },

    addProseMirrorPlugins() {
        const extensionThis = this;
        let lastMatch: SlashCommandMatch | null = null;

        return [
            new Plugin({
                key: slashCommandPluginKey,
                view() {
                    return {
                        destroy() {
                            lastMatch = null;
                        },
                        update(view) {
                            const { state } = view;
                            const { selection } = state;

                            // Only process when cursor is collapsed (not a range selection)
                            if (!selection.empty) {
                                if (lastMatch !== null) {
                                    lastMatch = null;
                                    extensionThis.options.onStateChange(null);
                                }

                                return;
                            }

                            // Get the full text and cursor offset
                            const fullText = state.doc.textBetween(0, state.doc.content.size, "\n");
                            const cursorPos = selection.from;

                            // Calculate text offset from doc position
                            let textOffset = 0;
                            let isFound = false;

                            state.doc.descendants((node, pos) => {
                                if (isFound) {
                                    return false;
                                }

                                if (node.isText) {
                                    const nodeEnd = pos + node.nodeSize;

                                    if (cursorPos >= pos && cursorPos <= nodeEnd) {
                                        textOffset += cursorPos - pos;
                                        isFound = true;

                                        return false;
                                    }

                                    textOffset += node.text!.length;
                                } else {
                                    textOffset += nonTextLength(node, pos);
                                }

                                return true;
                            });

                            if (!isFound) {
                                // Cursor might be at end of doc or in an empty paragraph
                                textOffset = fullText.length;
                            }

                            const parsed = parseSlashAtCursor(fullText, textOffset);

                            if (parsed) {
                                // Map text offsets back to doc positions
                                let from = 0;
                                let to = 0;
                                let currentTextOffset = 0;
                                let isFoundFrom = false;
                                let isFoundTo = false;

                                state.doc.descendants((node, pos) => {
                                    if (isFoundFrom && isFoundTo) {
                                        return false;
                                    }

                                    if (node.isText) {
                                        const nodeTextEnd = currentTextOffset + node.text!.length;

                                        if (!isFoundFrom && parsed.slashStartOffset >= currentTextOffset && parsed.slashStartOffset <= nodeTextEnd) {
                                            from = pos + (parsed.slashStartOffset - currentTextOffset);
                                            isFoundFrom = true;
                                        }

                                        if (!isFoundTo && parsed.slashEndOffset >= currentTextOffset && parsed.slashEndOffset <= nodeTextEnd) {
                                            to = pos + (parsed.slashEndOffset - currentTextOffset);
                                            isFoundTo = true;
                                        }

                                        currentTextOffset = nodeTextEnd;
                                    } else {
                                        currentTextOffset += nonTextLength(node, pos);
                                    }

                                    return true;
                                });

                                if (!isFoundTo) {
                                    to = state.doc.content.size;
                                }

                                const newMatch: SlashCommandMatch = {
                                    command: parsed.command,
                                    from,
                                    wholeDraft: isWholeDraft(fullText, parsed.slashStartOffset, parsed.slashEndOffset),
                                    query: parsed.query,
                                    startOffset: parsed.slashStartOffset,
                                    text: fullText.slice(parsed.slashStartOffset, parsed.slashEndOffset),
                                    to,
                                };

                                // Only notify if match changed
                                if (
                                    !lastMatch ||
                                    lastMatch.command !== newMatch.command ||
                                    lastMatch.query !== newMatch.query ||
                                    lastMatch.from !== newMatch.from ||
                                    lastMatch.to !== newMatch.to ||
                                    lastMatch.wholeDraft !== newMatch.wholeDraft ||
                                    lastMatch.text !== newMatch.text
                                ) {
                                    lastMatch = newMatch;
                                    extensionThis.options.onStateChange(newMatch);
                                }
                            } else if (lastMatch !== null) {
                                lastMatch = null;
                                extensionThis.options.onStateChange(null);
                            }
                        },
                    };
                },
            }),
        ];
    },

    name: "slashCommand",
});

export default SlashCommand;
