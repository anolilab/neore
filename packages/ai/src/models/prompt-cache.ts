/**
 * What a cold prompt cache costs, as one number two callers share: the gateway's router refuses a
 * tier downgrade above it, and a thread's agent switch warns above it. Both mean the same thing —
 * a provider's cache holds a prefix for one model, so changing model re-sends the conversation as
 * fresh input tokens, and past this size that re-send outweighs what the change saves.
 */

/**
 * Conversation size above which a model change costs a noticeable cold re-send. Tune against
 * observed `cache_creation` tokens if the provider mix changes.
 */
export const PROMPT_CACHE_COLD_START_TOKENS = 20_000;

/** The size approximation every caller of {@link PROMPT_CACHE_COLD_START_TOKENS} uses. */
export const CHARACTERS_PER_TOKEN = 4;

/** Rough token count of `characters` of text. Only the magnitude matters, so no tokenizer. */
export const estimateTokensFromCharacters = (characters: number): number => characters / CHARACTERS_PER_TOKEN;
