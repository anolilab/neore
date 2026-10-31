/**
 * The globs a hooks file may carry. The file is repository content, so the dialect is small and checked before
 * anything is compiled: relative paths, `*`, `**` (a whole segment), `?` and one level of `{a,b}`. Matching is by
 * segment with a linear wildcard walk, never a regular expression, so a hostile pattern cannot take the main process's time.
 */

const MAX_GLOB = 200;
const MAX_ALTERNATIVES = 16;
const MAX_WILDCARDS_PER_SEGMENT = 4;
const MAX_EXPANSIONS = 32;

// eslint-disable-next-line no-control-regex -- control characters are what is being refused
const CONTROL = /[\u{0}-\u{1F}\u{7F}]/u;
const ALLOWED = /^[\w\-./*?{},@+= ]+$/u;

/** Expands the single brace group, if any. `null` when the braces are nested, unbalanced or too many. */
const expandBraces = (glob: string): string[] | null => {
    const open = glob.indexOf("{");
    const close = glob.indexOf("}");

    if (open === -1 && close === -1) {
        return [glob];
    }

    if (open === -1 || close < open || glob.includes("{", open + 1) || glob.includes("}", close + 1)) {
        return null;
    }

    const alternatives = glob.slice(open + 1, close).split(",");

    if (alternatives.length < 2 || alternatives.length > MAX_ALTERNATIVES || alternatives.some((alternative) => alternative.includes("/"))) {
        return null;
    }

    return alternatives.map((alternative) => `${glob.slice(0, open)}${alternative}${glob.slice(close + 1)}`);
};

const segmentProblem = (segment: string): string | null => {
    if (["", ".", ".."].includes(segment)) {
        return "a segment is empty, \".\" or \"..\"";
    }

    if (segment !== "**" && segment.includes("**")) {
        return "\"**\" must be a whole path segment";
    }

    if (segment.split("*").length - 1 + segment.split("?").length - 1 > MAX_WILDCARDS_PER_SEGMENT) {
        return "too many wildcards in one segment";
    }

    return null;
};

/** Why a glob is not allowed, or `null`. */
export const globProblem = (glob: string): string | null => {
    if (glob === "" || glob.length > MAX_GLOB) {
        return `a glob is 1 to ${String(MAX_GLOB)} characters`;
    }

    if (CONTROL.test(glob) || !ALLOWED.test(glob)) {
        return "a glob may use letters, digits, . _ - / * ? and one {a,b} group";
    }

    if (glob.startsWith("/") || glob.startsWith("!")) {
        return "a glob is relative to the folder and cannot be negated";
    }

    const expanded = expandBraces(glob);

    if (expanded === null || expanded.length > MAX_EXPANSIONS) {
        return "use at most one {a,b} group, without nesting";
    }

    for (const candidate of expanded) {
        for (const segment of candidate.split("/")) {
            const problem = segmentProblem(segment);

            if (problem !== null) {
                return problem;
            }
        }
    }

    return null;
};

/**
 * One segment against one candidate: `*` is any run of characters, `?` one. The classic two-pointer walk that, on a
 * mismatch, retries from the last `*` one character further on. It never backtracks further than that star, so the
 * work is at most pattern length times candidate length, whatever the pattern.
 */
const wildcardMatch = (pattern: string[], candidate: string[]): boolean => {
    let patternIndex = 0;
    let candidateIndex = 0;
    let star = -1;
    let resume = 0;

    while (candidateIndex < candidate.length) {
        const part = pattern[patternIndex];

        if (part === "*") {
            star = patternIndex;
            resume = candidateIndex;
            patternIndex += 1;
        } else if (part !== undefined && (part === "?" || part === candidate[candidateIndex])) {
            patternIndex += 1;
            candidateIndex += 1;
        } else if (star === -1) {
            return false;
        } else {
            resume += 1;
            candidateIndex = resume;
            patternIndex = star + 1;
        }
    }

    while (pattern[patternIndex] === "*") {
        patternIndex += 1;
    }

    return patternIndex === pattern.length;
};

const segmentMatcher = (segment: string): (candidate: string) => boolean => {
    if (segment === "**") {
        return () => true;
    }

    // By code point, so `?` is one character as a person counts it and not half of a surrogate pair.
    const pattern = [...segment];

    return (candidate) => wildcardMatch(pattern, [...candidate]);
};

const matchSegments = (pattern: { globstar: boolean; test: (candidate: string) => boolean }[], candidate: string[]): boolean => {
    const memo = new Map<number, boolean>();

    const walk = (patternIndex: number, candidateIndex: number): boolean => {
        const key = patternIndex * (candidate.length + 1) + candidateIndex;
        const known = memo.get(key);

        if (known !== undefined) {
            return known;
        }

        let result: boolean;
        const part = pattern[patternIndex];

        if (part === undefined) {
            result = candidateIndex === candidate.length;
        } else if (part.globstar) {
            result = walk(patternIndex + 1, candidateIndex) || (candidateIndex < candidate.length && walk(patternIndex, candidateIndex + 1));
        } else {
            result = candidateIndex < candidate.length && part.test(candidate[candidateIndex] as string) && walk(patternIndex + 1, candidateIndex + 1);
        }

        memo.set(key, result);

        return result;
    };

    return walk(0, 0);
};

/**
 * A matcher for a glob that passed {@link globProblem} (an invalid one matches nothing). It takes a path relative to the
 * folder with `/` separators, and refuses one that is absolute or has a `.` / `..` / empty segment.
 */
export const compileGlob = (glob: string): (relativePath: string) => boolean => {
    const expanded = globProblem(glob) === null ? expandBraces(glob) : null;

    if (expanded === null) {
        return () => false;
    }

    const patterns = expanded.map((candidate) =>
        candidate.split("/").map((segment) => {
            return { globstar: segment === "**", test: segmentMatcher(segment) };
        }),
    );

    return (relativePath) => {
        const segments = relativePath.split("/");

        if (segments.some((segment) => ["", ".", ".."].includes(segment))) {
            return false;
        }

        return patterns.some((pattern) => matchSegments(pattern, segments));
    };
};
