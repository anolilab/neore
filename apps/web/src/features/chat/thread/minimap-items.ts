/**
 * Pure derivation for the thread minimap: one tick per user prompt, with a short
 * preview for its tooltip and accessible name.
 */

/** Below this many prompts the rail adds nothing and is not rendered. */
export const MINIMAP_MIN_PROMPTS = 3;

/** Longest preview kept, in characters, before it is cut with an ellipsis. */
export const MINIMAP_PREVIEW_CHARS = 80;

export interface MinimapItem {
    id: string;
    /** Single-line prompt text, cut to {@link MINIMAP_PREVIEW_CHARS}. Empty for an attachment-only prompt. */
    preview: string;
}

const WHITESPACE_RE = /\s+/g;

export const toMinimapPreview = (text: string, maxChars: number = MINIMAP_PREVIEW_CHARS): string => {
    const flat = text.replaceAll(WHITESPACE_RE, " ").trim();

    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat;
};

/** The user prompts of a message list, in order. Callers pass the active branch path, so each prompt appears once. */
export const buildMinimapItems = (messages: ReadonlyArray<{ id: string; role: string; text: string }>): MinimapItem[] =>
    messages
        .filter((message) => message.role === "user")
        .map((message) => {
            return { id: message.id, preview: toMinimapPreview(message.text) };
        });

export const shouldShowMinimap = (items: ReadonlyArray<MinimapItem>): boolean => items.length >= MINIMAP_MIN_PROMPTS;
