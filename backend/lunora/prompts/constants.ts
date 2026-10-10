/**
 * Maximum number of prompts allowed for free users
 */
export const FREE_PROMPT_LIMIT = 3;

/**
 * Regex pattern for matching variable placeholders in prompt content
 * Matches patterns like {{VARIABLE_NAME}} or {{config.BRAND}}
 */
export const VARIABLE_REGEX = /\{\{([a-z_][\w.]*)\}\}/gi;
