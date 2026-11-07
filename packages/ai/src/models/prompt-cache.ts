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

/**
 * How long a provider keeps a conversation prefix cached after its last use: the shortest default among the
 * providers the gateway routes to. A thread idle for longer than this re-reads its whole context as fresh input
 * on the next reply, which is when compacting it first pays off. Providers that cache longer only make the
 * suggestion early, never wrong.
 */
export const PROMPT_CACHE_LIFETIME_MS = 5 * 60 * 1000;

/** The size approximation every caller of {@link PROMPT_CACHE_COLD_START_TOKENS} uses. */
export const CHARACTERS_PER_TOKEN = 4;

/** Rough token count of `characters` of text. Only the magnitude matters, so no tokenizer. */
export const estimateTokensFromCharacters = (characters: number): number => characters / CHARACTERS_PER_TOKEN;

/**
 * What re-sending `tokens` as fresh input costs on a model priced at `inputPerMillionUsd` dollars per million
 * input tokens (the gateway catalog's `pricing.input_per_million`), in microdollars. A dollar per million tokens
 * is exactly one microdollar per token, so the price is the multiplier. The cache-write surcharge some providers
 * add is not included: this is the floor the cost notice states.
 */
export const estimateInputCostMicrodollars = (tokens: number, inputPerMillionUsd: number): number => tokens * inputPerMillionUsd;
