/**
 * The limits of "Send feedback", shared with the web app (`@neore/backend/feedback-limits`),
 * so this file imports nothing.
 */

/** The most images one piece of feedback carries. */
export const MAX_FEEDBACK_IMAGES = 4;

/** The longest feedback text, in characters. */
export const MAX_FEEDBACK_MESSAGE_LENGTH = 5000;

/** The largest feedback image, in bytes. The web app downscales a larger photo below this before it uploads. */
export const MAX_FEEDBACK_IMAGE_BYTES = 5 * 1024 * 1024;

/** Still images only: a feedback image is looked at, never run or played. SVG is left out, it can carry script. */
export const FEEDBACK_IMAGE_TYPES: ReadonlyArray<string> = ["image/gif", "image/jpeg", "image/png", "image/webp"];
