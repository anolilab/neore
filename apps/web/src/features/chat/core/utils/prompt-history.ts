/**
 * Prompt history — shell-style recall of the current thread's previous user
 * messages in the composer.
 *
 * Pure state machine: the composer owns WHEN a key counts as history navigation
 * (cursor at the start for ArrowUp, at the end for ArrowDown, no popup open);
 * this module owns WHAT the navigation does to the text.
 */

import type { DraftFrom } from "@neore/backend/not-typed-text";
import { draftFromOfMarks, mergeNotTypedMarks, notTypedMarksOfPart } from "@neore/backend/not-typed-text";

/** `null` while the user is editing their own draft rather than a recalled entry. */
export type PromptHistoryState = {
    /** The unsent text the user had before the first ArrowUp; restored on the way back down or on Escape. */
    draft: string;
    /** Index into the newest-first entry list. */
    index: number;
} | null;

export type PromptHistoryDirection = "down" | "escape" | "up";

export interface PromptHistoryStep {
    state: PromptHistoryState;
    text: string;
}

interface MessageLike {
    parts?: ReadonlyArray<{ providerMetadata?: unknown; text?: string; type: string }>;
    role: string;
    text?: string;
}

const messageText = (message: MessageLike): string => {
    if (message.text) {
        return message.text;
    }

    return (message.parts ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
};

/**
 * The thread's user messages as history entries, NEWEST first, blank ones
 * dropped and consecutive duplicates collapsed (so re-sending the same prompt
 * three times costs one ArrowUp, not three).
 */
export const buildPromptHistoryEntries = (messages: ReadonlyArray<MessageLike>): string[] => {
    const entries: string[] = [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (message?.role !== "user") {
            continue;
        }

        const text = messageText(message).trim();

        if (text && entries.at(-1) !== text) {
            entries.push(text);
        }
    }

    return entries;
};

/**
 * The not-typed mark of each entry whose message the server saved marked (`@neore/backend/not-typed-text`), so a recalled
 * entry goes out marked again: a draft's source, or `impersonated` for one an admin wrote as the owner. A text sent both
 * marked and unmarked keeps the mark.
 */
export const buildPromptHistoryMarks = (messages: ReadonlyArray<MessageLike>): Map<string, DraftFrom> => {
    const marks = new Map<string, DraftFrom>();

    for (const message of messages) {
        const draftFrom =
            message.role === "user"
                ? draftFromOfMarks(
                      mergeNotTypedMarks(
                          ...(message.parts ?? []).map((part) => (part.type === "text" ? notTypedMarksOfPart({ providerOptions: part.providerMetadata }) : {})),
                      ),
                  )
                : undefined;
        const text = messageText(message).trim();

        if (draftFrom !== undefined && text) {
            marks.set(text, draftFrom);
        }
    }

    return marks;
};

/**
 * One navigation step. Returns `null` when the key should NOT be consumed —
 * nothing older to recall, not currently navigating, and so on — so the editor's
 * default key behaviour runs instead.
 */
export const navigatePromptHistory = (
    state: PromptHistoryState,
    direction: PromptHistoryDirection,
    entries: ReadonlyArray<string>,
    currentText: string,
): PromptHistoryStep | null => {
    if (direction === "up") {
        const nextIndex = state === null ? 0 : state.index + 1;
        const entry = entries[nextIndex];

        if (entry === undefined) {
            return null;
        }

        return { state: { draft: state === null ? currentText : state.draft, index: nextIndex }, text: entry };
    }

    if (state === null) {
        return null;
    }

    if (direction === "escape" || state.index === 0) {
        return { state: null, text: state.draft };
    }

    const nextIndex = state.index - 1;

    return { state: { ...state, index: nextIndex }, text: entries[nextIndex] ?? state.draft };
};

const normalizeWhitespace = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/**
 * Whether the composer still shows the recalled entry. Once the user edits it,
 * it becomes their draft and navigation starts over from there. Whitespace is
 * normalised because the editor's plain-text round trip does not preserve blank
 * lines byte-for-byte.
 */
export const isStillRecalled = (state: PromptHistoryState, entries: ReadonlyArray<string>, text: string): boolean => {
    const entry = state === null ? undefined : entries[state.index];

    return entry !== undefined && normalizeWhitespace(entry) === normalizeWhitespace(text);
};
