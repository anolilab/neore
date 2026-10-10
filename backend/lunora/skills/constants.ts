/**
 * Maximum number of skills allowed for free users
 * Set to 5 (vs 3 for prompts) acknowledging skills are more complex
 */
export const FREE_SKILL_LIMIT = 5;

/**
 * Regex pattern for matching variable placeholders in skill instructions
 * Matches patterns like {{VARIABLE_NAME}} or {{config.BRAND}}
 * Reused from prompts system for consistency
 */
export const VARIABLE_REGEX = /\{\{([a-z_][\w.]*)\}\}/gi;

/**
 * Reserved skill slugs that cannot be used by users
 */
export const RESERVED_SLUGS = ["anthropic", "claude", "neore", "system", "admin"];

/**
 * File size limits in bytes
 */
export const FILE_SIZE_LIMITS = {
    asset: 10 * 1024 * 1024, // 10MB
    reference: 512 * 1024, // 512KB
    script: 1 * 1024 * 1024, // 1MB
} as const;

/**
 * Slug validation regex
 * Max 64 chars, lowercase letters/numbers/hyphens only,
 * no leading/trailing hyphens, no consecutive hyphens
 */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Maximum slug length
 */
export const MAX_SLUG_LENGTH = 64;

/**
 * Maximum description length for Level 1 metadata injection
 */
export const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * The most enabled skills one user's run reads — the prompt budget for Level 1
 * metadata (~100 tokens each), and the bound on every `userSkills` scan that
 * feeds a run.
 */
export const MAX_ENABLED_SKILLS = 50;
