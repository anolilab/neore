/**
 * Which suggested next prompt, if any, the composer offers. Kept apart from the React hook so the rule is testable on its own.
 */

export interface CachedSuggestions {
    lastMessageId?: string;
    suggestions: string[];
}

export interface NextPromptInput {
    cached: CachedSuggestions | null | undefined;
    enabled: boolean;
    isRunning: boolean;
    /** The id of the newest reply, when that reply answers something the person wrote. */
    lastReplyId: string | undefined;
}

/**
 * The prompt to offer, or `null`: the setting is on, the chat is idle, and the cache is for that very reply. A suggestion made for
 * an older reply is never offered after a newer one.
 */
export const pickNextPrompt = ({ cached, enabled, isRunning, lastReplyId }: NextPromptInput): string | null => {
    if (!enabled || isRunning || lastReplyId === undefined || !cached || cached.lastMessageId !== lastReplyId) {
        return null;
    }

    const first = cached.suggestions[0]?.trim();

    return first || null;
};
