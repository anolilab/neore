/**
 * Matching a required-check name against a pattern the host sent (`ci/*`, `build?`).
 * Patterns come from branch protection and rulesets, so they are hostile input: this is
 * an iterative matcher, never a regular expression and never recursive. `*` matches any
 * run of characters, `?` exactly one, everything else is literal. It remembers only the
 * LAST `*` to fall back on, so no earlier star is ever retried and the work cannot grow
 * exponentially. The work is at most pattern length × text length comparisons (not linear), and both
 * lengths are capped at 512, so it never passes 262,144.
 */

/** Longest pattern and name this will compare; a longer one is not matched, it is declined. */
export const GLOB_MAX_CHARS = 512;

/**
 * Whether `text` matches `pattern`, or `null` when either is longer than {@link GLOB_MAX_CHARS}
 * and was not compared: a caller treats that as "cannot tell", never as "no match".
 */
export const matchesGlob = (pattern: string, text: string): boolean | null => {
    if (pattern.length > GLOB_MAX_CHARS || text.length > GLOB_MAX_CHARS) {
        return null;
    }

    let patternAt = 0;
    let textAt = 0;
    let star = -1;
    let resume = 0;

    while (textAt < text.length) {
        const symbol = pattern[patternAt];

        if (symbol === "*") {
            star = patternAt;
            resume = textAt;
            patternAt += 1;
        } else if (symbol !== undefined && (symbol === "?" || symbol === text[textAt])) {
            patternAt += 1;
            textAt += 1;
        } else if (star === -1) {
            return false;
        } else {
            // Let the last star take one more character and try the rest of the pattern again.
            patternAt = star + 1;
            resume += 1;
            textAt = resume;
        }
    }

    while (pattern[patternAt] === "*") {
        patternAt += 1;
    }

    return patternAt === pattern.length;
};
