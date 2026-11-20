/**
 * The limits a project's rule files are saved under, shared with the web app (`@neore/backend/rule-file-limits`), so
 * the editor refuses what `normalizeRuleFiles` (`rule-files.ts`) would, with the same field named. This file imports
 * nothing: the web app bundles it.
 */

/** Rule files one project holds. */
export const MAX_RULE_FILES = 20;
/** Characters one rule file holds. */
export const MAX_RULE_FILE_LENGTH = 100_000;
/**
 * UTF-8 bytes all of a project's rule files take together as stored, JSON-encoded (escapes included): their row lives in
 * D1, whose rows stay under 2 MB. Measured by {@link ruleFilesStoredBytes}.
 */
export const MAX_RULE_FILES_BYTES = 1_000_000;
/** Characters of a rule file's name, trimmed. */
export const MAX_RULE_TITLE_LENGTH = 200;
export const MAX_RULE_ID_LENGTH = 64;
/** Patterns one `glob` file holds. */
export const MAX_RULE_GLOBS = 10;
/** Characters of one pattern, trimmed. */
export const MAX_RULE_GLOB_LENGTH = 200;

/**
 * The `data.code` of a save refused at one of the limits above, beside the `fileId` it names when it names a file. The
 * editor words each the way it words its own check, so a client and a server that disagree on a limit still name the
 * field.
 */
export const RULE_FILE_REFUSALS = {
    CONTENT_TOO_LONG: "RULE_FILE_CONTENT_TOO_LONG",
    PATTERN_INVALID: "RULE_FILE_PATTERN_INVALID",
    PATTERNS_MISSING: "RULE_FILE_PATTERNS_MISSING",
    PATTERNS_TOO_MANY: "RULE_FILE_PATTERNS_TOO_MANY",
    TITLE_MISSING: "RULE_FILE_TITLE_MISSING",
    TITLE_TOO_LONG: "RULE_FILE_TITLE_TOO_LONG",
    TOO_LARGE: "RULE_FILES_TOO_LARGE",
    TOO_MANY: "RULE_FILES_TOO_MANY",
} as const;

export type RuleFileRefusal = (typeof RULE_FILE_REFUSALS)[keyof typeof RULE_FILE_REFUSALS];

const LINE_BREAK_OR_NUL = /[\0\n\r]/u;

/** Whether `glob`, trimmed, is a pattern a save takes: 1 to {@link MAX_RULE_GLOB_LENGTH} characters, no line break or NUL. */
export const isRuleGlobValid = (glob: string): boolean => glob.trim().length > 0 && glob.length <= MAX_RULE_GLOB_LENGTH && !LINE_BREAK_OR_NUL.test(glob);

/** The UTF-8 bytes `files` take stored, as JSON: the measure of {@link MAX_RULE_FILES_BYTES}. */
export const ruleFilesStoredBytes = (files: ReadonlyArray<unknown>): number => new TextEncoder().encode(JSON.stringify(files)).byteLength;
