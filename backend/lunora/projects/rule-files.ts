/**
 * A project's rule files (`projects.ruleFiles`): the owner's instructions for the project's runs, each with a mode. An
 * `always` file reaches every run; a `glob` file only a run whose files match one of its patterns. A project written
 * before rule files keeps its `context` text, which reads as the first `always` file ({@link projectRuleFiles}) until
 * the rule files are first saved, which moves it into the list. The text is the owner's: never logged.
 */
import { LunoraError } from "lunorash/server";

export type RuleFileMode = "always" | "glob";

export interface RuleFile {
    content: string;
    globs?: string[];
    id: string;
    mode: RuleFileMode;
    title: string;
}

/** Rule files one project holds. */
export const MAX_RULE_FILES = 20;
/** Characters one rule file holds. */
export const MAX_RULE_FILE_LENGTH = 100_000;
/**
 * UTF-8 bytes all of a project's rule files take together as stored, JSON-encoded (escapes included): the project row
 * lives in D1, whose rows stay under 2 MB.
 */
export const MAX_RULE_FILES_BYTES = 1_000_000;
/**
 * UTF-8 bytes a whole project row takes, JSON-encoded, after a rule-file save ({@link assertProjectRowFits}): D1 refuses a
 * row past 2,000,000 bytes, and the rest is the margin for the row's own encoding. The JSON of the whole document is never
 * smaller than what D1 stores for it, so a row this check lets through fits.
 */
export const MAX_PROJECT_ROW_BYTES = 1_900_000;
/** Characters of rule-file text one run takes; the rest is left out ({@link selectRuleFiles}). */
export const MAX_RULE_TEXT_PER_RUN = 200_000;
export const MAX_RULE_TITLE_LENGTH = 200;
export const MAX_RULE_ID_LENGTH = 64;
export const MAX_RULE_GLOBS = 10;
export const MAX_RULE_GLOB_LENGTH = 200;

/** The id the legacy `context` text reads under; the editor sends it back as an ordinary file. */
export const LEGACY_CONTEXT_RULE_ID = "context";

/** Marks a file cut at the run's budget, so the model knows the text does not end there. */
const TRUNCATED_NOTE = "\n[…truncated]";

/**
 * The files {@link projectRuleFiles} made from a legacy `context`: a run takes their text whole, as it took `context`
 * before rule files ({@link selectRuleFiles}). Kept beside the files, not on them, so no output carries the mark.
 */
const LEGACY_CONTEXT_FILES = new WeakSet<RuleFile>();

/**
 * The project's rule files in order: a legacy `context` first, as an `always` file, then the saved list. A project
 * whose rule files were saved has no `context` left, unless a client that still writes it set it again since.
 */
export const projectRuleFiles = (project: { context?: string | null; ruleFiles?: RuleFile[] | null }): RuleFile[] => {
    const files = project.ruleFiles ?? [];

    if (!project.context) {
        return files;
    }

    // An id the list does not hold already, so the editor's keys and a save stay unambiguous.
    const taken = new Set(files.map((file) => file.id));
    let id = LEGACY_CONTEXT_RULE_ID;
    let suffix = 2;

    while (taken.has(id)) {
        id = `${LEGACY_CONTEXT_RULE_ID}-${suffix}`;
        suffix += 1;
    }

    const legacy: RuleFile = { content: project.context, id, mode: "always", title: "Project context" };

    LEGACY_CONTEXT_FILES.add(legacy);

    return [legacy, ...files];
};

/** A leading `./` or `/`, which neither a pattern nor a path is matched with. */
const LEADING_ROOT = /^(?:\.\/|\/)+/u;

/** Alternatives one pattern's `{a,b}` groups expand to, at most; past it the rest are not tried. */
const MAX_GLOB_EXPANSIONS = 64;
/** Characters of a path that are matched; a longer one is cut (a file name or a path in a repository is far shorter). */
const MAX_MATCHED_PATH_LENGTH = 1024;

/** `glob` with each `{a,b}` group (not nested) expanded into its alternatives, up to {@link MAX_GLOB_EXPANSIONS}. */
const expandBraces = (glob: string): string[] => {
    const open = glob.indexOf("{");
    const close = open === -1 ? -1 : glob.indexOf("}", open);

    if (close === -1) {
        return [glob];
    }

    const head = glob.slice(0, open);
    const expanded: string[] = [];

    const tails = expandBraces(glob.slice(close + 1));
    const choices = glob.slice(open + 1, close).split(",");

    for (const tail of tails) {
        for (const choice of choices) {
            if (expanded.length >= MAX_GLOB_EXPANSIONS) {
                return expanded;
            }

            expanded.push(`${head}${choice}${tail}`);
        }
    }

    return expanded;
};

/** Matching steps one run spends on all its patterns and paths together; past it nothing more matches. */
export const GLOB_MATCH_STEPS_PER_RUN = 2_000_000;

/** What one run's matching may still spend, shared by every pattern it tries ({@link GLOB_MATCH_STEPS_PER_RUN}). */
export interface MatchBudget {
    steps: number;
}

/**
 * Whether `subject` matches `pattern` (no braces): `*` and `?` stay inside a path segment, `**` crosses them, and a `**`
 * followed by a slash also matches no folder at all. Each (pattern position, subject position) is worked out once, in a
 * constant number of steps, so a pattern like `*a*a*a` costs at most pattern × subject steps, each spent from `budget`;
 * an exhausted budget answers no match.
 */
const matchPattern = (pattern: string, subject: string, budget: MatchBudget): boolean => {
    // The setup below walks the subject once: charged too, so a spent budget stops every later call before any work.
    budget.steps -= subject.length + 1;

    if (budget.steps <= 0) {
        return false;
    }

    const memo = new Map<number, boolean>();
    const width = subject.length + 1;
    // Where the next `/` at or after each position is, so skipping a folder is one step.
    const nextSlash: number[] = Array.from({ length: width });

    nextSlash[subject.length] = -1;

    for (let index = subject.length - 1; index >= 0; index -= 1) {
        nextSlash[index] = subject[index] === "/" ? index : nextSlash[index + 1]!;
    }

    const at = (pi: number, si: number): boolean => {
        const key = pi * width + si;
        const known = memo.get(key);

        if (known !== undefined) {
            return known;
        }

        if (budget.steps <= 0) {
            return false;
        }

        budget.steps -= 1;

        let result: boolean;
        const more = si < subject.length;

        if (pi === pattern.length) {
            result = !more;
        } else if (pattern.startsWith("**/", pi)) {
            const slash = nextSlash[si]!;

            result = at(pi + 3, si) || (slash !== -1 && at(pi, slash + 1));
        } else if (pattern.startsWith("**", pi)) {
            result = at(pi + 2, si) || (more && at(pi, si + 1));
        } else if (pattern[pi] === "*") {
            result = at(pi + 1, si) || (more && subject[si] !== "/" && at(pi, si + 1));
        } else if (pattern[pi] === "?") {
            result = more && subject[si] !== "/" && at(pi + 1, si + 1);
        } else {
            result = more && subject[si] === pattern[pi] && at(pi + 1, si + 1);
        }

        memo.set(key, result);

        return result;
    };

    return at(0, 0);
};

/**
 * Whether `path` matches `glob`. A pattern without a `/` is matched against the file's name alone (`*.sql` matches
 * `db/schema.sql`); one with a `/` against the whole path. Backslashes count as `/` in both, a leading `./` or `/` is
 * ignored.
 */
export const matchesGlob = (glob: string, path: string, shared?: MatchBudget): boolean => {
    const budget = shared ?? { steps: GLOB_MATCH_STEPS_PER_RUN };

    if (budget.steps <= 0) {
        return false;
    }

    const normalized = path.replaceAll("\\", "/").replace(LEADING_ROOT, "").slice(0, MAX_MATCHED_PATH_LENGTH);
    const trimmed = glob.trim().replaceAll("\\", "/").replace(LEADING_ROOT, "");

    if (!trimmed || !normalized) {
        return false;
    }

    return expandBraces(trimmed).some((pattern) =>
        matchPattern(pattern, pattern.includes("/") ? normalized : normalized.slice(normalized.lastIndexOf("/") + 1), budget),
    );
};

/**
 * The files a run takes, in the project's order: every `always` file, and each `glob` file one of whose patterns matches
 * one of `paths`. Their text together stays within {@link MAX_RULE_TEXT_PER_RUN}: the file that reaches it is cut there
 * (marked) and the ones after it are left out, counted in `omitted`. A legacy `context` is taken whole, as before rule
 * files, and not counted: one kept beside the files (`keepContext`) would otherwise leave them nothing. `matchingCut` says the matching budget ran out, so some pattern was not tried.
 */
export const selectRuleFiles = (files: RuleFile[], paths: string[]): { files: RuleFile[]; matchingCut: boolean; omitted: number; truncated: boolean } => {
    const budget: MatchBudget = { steps: GLOB_MATCH_STEPS_PER_RUN };
    const applicable = files.filter(
        (file) => file.mode === "always" || (file.globs ?? []).some((glob) => paths.some((path) => matchesGlob(glob, path, budget))),
    );
    const selected: RuleFile[] = [];
    let left = MAX_RULE_TEXT_PER_RUN;
    let truncated = false;

    for (const file of applicable) {
        if (LEGACY_CONTEXT_FILES.has(file)) {
            selected.push(file);
            continue;
        }

        if (left <= 0) {
            break;
        }

        if (file.content.length > left) {
            selected.push({ ...file, content: `${file.content.slice(0, left)}${TRUNCATED_NOTE}` });
            truncated = true;
            left = 0;
            continue;
        }

        selected.push(file);
        left -= file.content.length;
    }

    return { files: selected, matchingCut: budget.steps <= 0, omitted: applicable.length - selected.length, truncated };
};

/**
 * A short fingerprint of a list of rule files, in order: what the editor read, so a save from an older view is refused
 * (`setProjectRuleFiles`). FNV-1a over the JSON, with its length; not a security measure.
 */
export const ruleFilesRevision = (files: RuleFile[]): string => {
    const text = JSON.stringify(files.map((file) => [file.id, file.title, file.mode, file.globs ?? [], file.content]));
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ (text.codePointAt(index) ?? 0), 0x01_00_01_93) >>> 0;
    }

    return `${text.length.toString(36)}-${hash.toString(36)}`;
};

/** The text of the selected files for the prompt, joined; framed by the caller as `PROJECT CONTEXT:`, as `context` was. */
export const renderRuleFiles = (files: RuleFile[]): string | null => {
    const parts = files.map((file) => file.content).filter((content) => content.trim().length > 0);

    return parts.length > 0 ? parts.join("\n\n") : null;
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const LINE_BREAK_OR_NUL = /[\0\n\r]/u;

/** Refuses a glob a person could not have meant: empty, too long, or with a line break or a NUL. */
const assertGlob = (glob: string): void => {
    if (!glob.trim() || glob.length > MAX_RULE_GLOB_LENGTH || LINE_BREAK_OR_NUL.test(glob)) {
        throw new LunoraError("BAD_REQUEST", `A file pattern must be 1 to ${MAX_RULE_GLOB_LENGTH} characters on one line`);
    }
};

/**
 * The list as it is saved: trimmed titles and patterns, no patterns on an `always` file. Refuses a list past the
 * caps, a repeated id, an empty title, or a `glob` file without a pattern. What the rest of the row leaves room for is
 * checked where the row is written ({@link assertProjectRowFits}).
 */
export const normalizeRuleFiles = (files: RuleFile[]): RuleFile[] => {
    if (files.length > MAX_RULE_FILES) {
        throw new LunoraError("BAD_REQUEST", `A project holds at most ${MAX_RULE_FILES} rule files`);
    }

    const ids = new Set<string>();

    const normalized = files.map((file) => {
        const title = file.title.trim();

        if (!file.id || file.id.length > MAX_RULE_ID_LENGTH || ids.has(file.id)) {
            throw new LunoraError("BAD_REQUEST", "Each rule file needs its own id");
        }

        ids.add(file.id);

        if (!title || title.length > MAX_RULE_TITLE_LENGTH) {
            throw new LunoraError("BAD_REQUEST", `A rule file's name must be 1 to ${MAX_RULE_TITLE_LENGTH} characters`);
        }

        if (file.content.length > MAX_RULE_FILE_LENGTH) {
            throw new LunoraError("BAD_REQUEST", `A rule file holds at most ${MAX_RULE_FILE_LENGTH} characters`);
        }

        if (file.mode === "always") {
            return { content: file.content, id: file.id, mode: file.mode, title };
        }

        const globs = (file.globs ?? []).map((glob) => glob.trim());

        if (globs.length === 0 || globs.length > MAX_RULE_GLOBS) {
            throw new LunoraError("BAD_REQUEST", `A rule file applied by pattern needs 1 to ${MAX_RULE_GLOBS} patterns`);
        }

        for (const glob of globs) {
            assertGlob(glob);
        }

        return { content: file.content, globs, id: file.id, mode: file.mode, title };
    });

    if (utf8Bytes(JSON.stringify(normalized)) > MAX_RULE_FILES_BYTES) {
        throw new LunoraError("BAD_REQUEST", "The project's rule files are too large together");
    }

    return normalized;
};

/**
 * Refuses a rule-file save that would leave the project row past {@link MAX_PROJECT_ROW_BYTES}: the row as it would be
 * `written`, its other columns (a kept `context`, a workflow) included. A save that does not grow the row past `current`
 * is never refused, so a row already near the limit can still lose files. Called in the transaction that writes, on the
 * row read there, so a refusal says why instead of failing at the database.
 */
export const assertProjectRowFits = (written: unknown, current: unknown): void => {
    const bytes = utf8Bytes(JSON.stringify(written));

    if (bytes > MAX_PROJECT_ROW_BYTES && bytes > utf8Bytes(JSON.stringify(current))) {
        throw new LunoraError("BAD_REQUEST", "The rule files do not fit beside the project's other settings. Shorten them or remove some.");
    }
};
