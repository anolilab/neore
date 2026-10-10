/**
 * The text models a user without a paid plan may run on the platform's keys.
 * Everything else (Opus, GPT-5, o3, Gemini Pro, …) needs a paid plan, the
 * user's own provider key, or a custom endpoint. Image, video and music models
 * are not listed: their free use is capped per day by the rate limiter instead.
 * Guests are pinned to `ANONYMOUS_FREE_MODEL` before this is consulted.
 */
export const FREE_TIER_TEXT_MODELS: ReadonlySet<string> = new Set([
    "deepseek/deepseek-chat-v3.1",
    "gemma3-8b:free",
    "google/gemini-2.0-flash-001",
    "google/gemini-2.0-flash-lite-001",
    "google/gemini-2.5-flash-lite",
    "gpt-oss-20b:free",
    "meta-llama/llama-3.1-8b-instruct",
    "moonshotai/kimi-k2-0905",
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1-nano",
    "openai/gpt-5-nano",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "openrouter/free",
    "qwen3-8b:free",
    "qwen/qwen3-4b",
    "qwen/qwen3.5-flash",
]);

/** Whether running `model` on the platform's keys needs a paid plan. */
export const requiresPaidPlan = (model: { id: string; isPremium?: boolean; mode?: string }): boolean =>
    model.isPremium === true || ((model.mode === undefined || model.mode === "text") && !FREE_TIER_TEXT_MODELS.has(model.id));
