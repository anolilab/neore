// Text defaults run on Workers AI (the gateway's `AI` binding), so the app needs no
// provider key to chat. OpenRouter and the other providers stay selectable.
export const ANONYMOUS_FREE_MODEL = "cf-gpt-oss-20b";

export const DEFAULT_CHAT_MODEL = "cf-kimi-k2.5";
export const DEFAULT_PROMPT_IMPROVEMENT_MODEL = "cf-gpt-oss-120b";
/** Model used for user-prompt optimization (the composer Sparkles button). */
export const DEFAULT_USER_PROMPT_OPTIMIZATION_MODEL = "cf-gpt-oss-120b";
/** Model used for system-prompt optimization (heavier templates, longer outputs). */
export const DEFAULT_SYSTEM_PROMPT_OPTIMIZATION_MODEL = "cf-gpt-oss-120b";
/** Model used for iterating on a previously optimized prompt with user feedback. */
export const DEFAULT_PROMPT_ITERATION_MODEL = "cf-gpt-oss-120b";
export const DEFAULT_SUMMARIZATION_MODEL = "cf-gpt-oss-120b";
export const DEFAULT_TITLE_GENERATION_MODEL = "cf-gpt-oss-20b";
/** Longest user-written instruction for how thread titles are worded (`userSettings.threadTitleInstructions`). */
export const MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH = 200;

/**
 * Most characters one message may carry. Lunora rejects a JSON request over 1 MiB (413) and a character is up to 4 bytes
 * of UTF-8, so this stays well under it; the public API caps a prompt at the same number. Longer text goes in as a file.
 */
export const MAX_PROMPT_CHARS = 100_000;
export const DEFAULT_FOLLOWUP_SUGGESTIONS_MODEL = "cf-gpt-oss-20b";
export const DEFAULT_MEMORY_EXTRACTION_MODEL = "cf-gpt-oss-20b";

// Text models
export const DEFAULT_TEXT_TO_TEXT_MODEL = "cf-gpt-oss-120b";
export const DEFAULT_IMAGE_TO_TEXT_MODEL = "cf-llama-4-scout";
export const DEFAULT_VIDEO_TO_TEXT_MODEL = "cf-llama-4-scout";

// Image models
export const DEFAULT_IMAGE_MODEL = "fal-ai/flux-2-pro";
export const DEFAULT_TEXT_TO_IMAGE_MODEL = "fal-ai/flux-2-pro";
export const DEFAULT_IMAGE_TO_IMAGE_MODEL = "fal-ai/nano-banana";
export const DEFAULT_IMAGES_TO_IMAGE_MODEL = "fal-ai/nano-banana";

// Video models
export const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v1.5/pro";
export const DEFAULT_TEXT_TO_VIDEO_MODEL = "fal-ai/bytedance/seedance/v1.5/pro/text-to-video";
export const DEFAULT_IMAGE_TO_VIDEO_MODEL = "fal-ai/bytedance/seedance/v1.5/pro/image-to-video";
export const DEFAULT_IMAGES_TO_VIDEO_MODEL = "fal-ai/veo3.1/reference-to-video";
export const DEFAULT_VIDEO_TO_VIDEO_MODEL = "fal-ai/kling-video/o1/standard/video-to-video/edit";
export const DEFAULT_MIXED_TO_VIDEO_MODEL = "fal-ai/kling-video/o1/standard/video-to-video/edit";

// Other
export const DEFAULT_VOICE_MODEL = "google/gemini-2.5-flash-image";
export const DEFAULT_THREAD_TITLE = "New Chat";
