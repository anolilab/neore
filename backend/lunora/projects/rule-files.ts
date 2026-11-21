/**
 * A project's rule files (stored in `projectRuleFiles`, `rule-file-rows.ts`): the owner's instructions for the project's runs, each with a mode. An
 * `always` file reaches every run; a `glob` file only a run whose files match one of its patterns; an `auto` file is
 * listed by name and description, and the model reads it when it needs it (`instruction_read`). A project written
 * before rule files keeps its `context` text, which reads as the first `always` file ({@link projectRuleFiles}) until
 * the rule files are first saved, which moves it into the list. The text is the owner's: never logged.
 */
import { LunoraError } from "lunorash/server";

import {
    MAX_RULE_FILE_LENGTH,
    MAX_RULE_FILES,
    MAX_RULE_FILES_BYTES,
    isRuleDescriptionValid,
    isRuleGlobValid,
    MAX_RULE_DESCRIPTION_LENGTH,
    MAX_RULE_GLOB_LENGTH,
    MAX_RULE_GLOBS,
    MAX_RULE_ID_LENGTH,
    MAX_RULE_TITLE_LENGTH,
    RULE_FILE_REFUSALS,
    type RuleFileRefusal,
    ruleFilesStoredBytes,
} from "./rule-file-limits";

export type RuleFileMode = "always" | "auto" | "glob";

export interface RuleFile {
    content: string;
    /** An `auto` file's one-line description, listed in the run's prompt; only on `auto` files. */
    description?: string;
    globs?: string[];
    id: string;
    mode: RuleFileMode;
    title: string;
}

/** An `auto` rule file a run lists and may read (`instruction_read`), its text carried from the run's one read. */
export interface RunInstruction {
    content: string;
    description: string;
    id: string;
    title: string;
}

/** Characters of rule-file text one run takes; the rest is left out ({@link selectRuleFiles}). */
export const MAX_RULE_TEXT_PER_RUN = 200_000;

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
 * Whether {@link projectRuleFiles} made `file` from a legacy `context` it read: the one decision the editor's
 * `legacyContextId` and a run's whole-text rule come from, so a `context` it left out as carried is never named.
 */
export const isLegacyContextFile = (file: RuleFile): boolean => LEGACY_CONTEXT_FILES.has(file);

/**
 * The project's rule files in order: a legacy `context` first, as an `always` file, then the saved list. A project
 * whose rule files were saved has no `context` left, unless a client that still writes it set it again since, or the
 * save that carried it into the list failed to clear it: `carriedContext` is that save's {@link contextFingerprint}, and
 * a `context` matching it is in the list already, so it is not read twice.
 */
export const projectRuleFiles = (project: { carriedContext?: string | null; context?: string | null; ruleFiles?: RuleFile[] | null }): RuleFile[] => {
    const files = project.ruleFiles ?? [];

    if (!project.context || isCarriedContext(project.context, project.carriedContext)) {
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

/** What joins two files' text for a run ({@link renderRuleFiles}); counted in the run's budget. */
const RULE_FILE_SEPARATOR = "\n\n";

/** The name of the tool a run reads an `auto` file with (`chat/tools/instruction-read.ts`). */
export const INSTRUCTION_READ_TOOL = "instruction_read";

/** Heads the list of `auto` files in a run's prompt ({@link renderInstructionList}). */
const INSTRUCTION_LIST_HEADER = `Instruction files you can read with the ${INSTRUCTION_READ_TOOL} tool (as id:<its id>, or by its name) when one applies to the task:`;

const WHITESPACE_RUN = /\s+/gu;

/** `text` on one line, each run of white space one space: a name in the one-line list ({@link renderInstructionList}). */
export const oneLine = (text: string): string => text.replaceAll(WHITESPACE_RUN, " ").trim();

/** One `auto` file's line in that list. */
const instructionLine = (file: Pick<RuleFile, "description" | "id" | "title">): string =>
    `- ${oneLine(file.title)} (id: ${file.id}): ${oneLine(file.description ?? "")}`;

/**
 * The list of a run's `auto` files for its prompt, `null` for none: each by name, id and description, after the
 * {@link INSTRUCTION_LIST_HEADER}. Its length is what {@link selectRuleFiles} counts for them.
 */
export const renderInstructionList = (files: ReadonlyArray<Pick<RuleFile, "description" | "id" | "title">>): string | null =>
    files.length > 0 ? [INSTRUCTION_LIST_HEADER, ...files.map((file) => instructionLine(file))].join("\n") : null;

/**
 * The files a run takes, in the project's order: every `always` file, and each `glob` file one of whose patterns matches
 * one of `paths`, in `files`; every `auto` file in `instructions`, the ones the run lists and may read. Rendered
 * ({@link renderRuleFiles}, {@link renderInstructionList} after it), the text and the list stay within
 * {@link MAX_RULE_TEXT_PER_RUN}, the separators and the cut file's marker included: an `auto` file costs its line in the
 * list (the list's header with the first), never its text. An `auto` file whose line does not fit is left out and the
 * next one tried; the other file that reaches the budget is cut there (marked) and the ones after it are left out. The
 * skipped `auto` files and those after the cut are counted in `omitted`. So a selection that lists none has the `files`
 * that `listsInstructions: false` gives. A legacy `context` is taken whole, as before rule files, and not counted: one
 * kept beside the files (`keepContext`) would otherwise leave them nothing. `matchingCut` says the matching budget ran
 * out, so some pattern was not tried. `listsInstructions: false` is for a run that shows no list: its `auto` files are
 * neither taken nor counted, so they leave the other files all of the budget.
 */
export const selectRuleFiles = (
    files: RuleFile[],
    paths: string[],
    listsInstructions = true,
): { files: RuleFile[]; instructions: RuleFile[]; matchingCut: boolean; omitted: number; truncated: boolean } => {
    const budget: MatchBudget = { steps: GLOB_MATCH_STEPS_PER_RUN };
    const applicable = files.filter(
        (file) =>
            file.mode === "always" ||
            // An empty `auto` file would list a name with nothing to read.
            (file.mode === "auto" && listsInstructions && file.content.trim().length > 0) ||
            (file.globs ?? []).some((glob) => paths.some((path) => matchesGlob(glob, path, budget))),
    );
    const selected: RuleFile[] = [];
    const instructions: RuleFile[] = [];
    let left = MAX_RULE_TEXT_PER_RUN;
    let truncated = false;
    // Whether text is already rendered, so the next file's text comes after a separator.
    let started = false;

    for (const file of applicable) {
        const blank = file.content.trim().length === 0;

        // A blank file renders nothing (`renderRuleFiles`), so it costs nothing.
        if (isLegacyContextFile(file) || blank) {
            selected.push(file);
            started ||= !blank;
            continue;
        }

        const separator = started ? RULE_FILE_SEPARATOR.length : 0;

        if (file.mode === "auto") {
            // The list is one block: its header and the separator before it come with its first line.
            const cost = (instructions.length === 0 ? separator + INSTRUCTION_LIST_HEADER.length : 0) + 1 + instructionLine(file).length;

            // A line that does not fit is left out, never the end: a shorter one or a file after it may still fit.
            if (cost > left) {
                continue;
            }

            instructions.push(file);
            left -= cost;
            started = true;
            continue;
        }

        if (separator + file.content.length <= left) {
            selected.push(file);
            left -= separator + file.content.length;
            started = true;
            continue;
        }

        const room = left - separator - TRUNCATED_NOTE.length;

        if (room > 0) {
            selected.push({ ...file, content: `${file.content.slice(0, room)}${TRUNCATED_NOTE}` });
            truncated = true;
        }

        break;
    }

    return { files: selected, instructions, matchingCut: budget.steps <= 0, omitted: applicable.length - selected.length - instructions.length, truncated };
};

/** FNV-1a over `text`, with its length; not a security measure. */
const fingerprint = (text: string): string => {
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ (text.codePointAt(index) ?? 0), 0x01_00_01_93) >>> 0;
    }

    return `${text.length.toString(36)}-${hash.toString(36)}`;
};

/**
 * A short fingerprint of a list of rule files, in order: what the editor read, so a save from an older view is refused
 * (`setProjectRuleFiles`): {@link fingerprint} over the JSON.
 */
export const ruleFilesRevision = (files: RuleFile[]): string =>
    // A description only when present, so a list saved before `auto` files keeps the revision it had.
    fingerprint(
        JSON.stringify(
            files.map((file) => [
                file.id,
                file.title,
                file.mode,
                file.globs ?? [],
                file.content,
                ...(file.description === undefined ? [] : [file.description]),
            ]),
        ),
    );

/**
 * The fingerprint a save that carries a legacy `context` into the list stores beside it (`carriedContext`), so a
 * `context` it could not clear afterwards reads as carried ({@link projectRuleFiles}), never as a second copy.
 */
export const contextFingerprint = (context: string): string => fingerprint(context);

/** Whether `context` is the one a save carried into the list, by its {@link contextFingerprint}. */
export const isCarriedContext = (context: string, carriedContext: string | null | undefined): boolean =>
    Boolean(carriedContext) && carriedContext === contextFingerprint(context);

/** The text of the selected files for the prompt, joined; framed by the caller as `PROJECT CONTEXT:`, as `context` was. */
export const renderRuleFiles = (files: RuleFile[]): string | null => {
    const parts = files.map((file) => file.content).filter((content) => content.trim().length > 0);

    return parts.length > 0 ? parts.join(RULE_FILE_SEPARATOR) : null;
};

/** A save refused at a limit: its code ({@link RULE_FILE_REFUSALS}) and the file it names, for the editor to word. */
const refuse = (message: string, code: RuleFileRefusal, fileId?: string): LunoraError =>
    new LunoraError("BAD_REQUEST", message, { data: { code, ...(fileId !== undefined && { fileId }) } });

/** Refuses a glob a person could not have meant: empty, too long, or with a line break or a NUL. */
const assertGlob = (glob: string, fileId: string): void => {
    if (!isRuleGlobValid(glob)) {
        throw refuse(`A file pattern must be 1 to ${MAX_RULE_GLOB_LENGTH} characters on one line`, RULE_FILE_REFUSALS.PATTERN_INVALID, fileId);
    }
};

/**
 * The list as it is saved: trimmed titles, patterns and descriptions, patterns only on a `glob` file and a description
 * only on an `auto` one. Refuses a list past the caps, a repeated id, an empty title, a `glob` file without a pattern,
 * or an `auto` file without a one-line description. `alongside` counts the files the project
 * keeps outside the list (a kept legacy `context`), so the project still holds at most {@link MAX_RULE_FILES}.
 */
export const normalizeRuleFiles = (files: RuleFile[], { alongside = 0 } = {}): RuleFile[] => {
    if (files.length + alongside > MAX_RULE_FILES) {
        throw refuse(`A project holds at most ${MAX_RULE_FILES} rule files`, RULE_FILE_REFUSALS.TOO_MANY);
    }

    const ids = new Set<string>();

    const normalized = files.map((file) => {
        const title = file.title.trim();

        if (!file.id || file.id.length > MAX_RULE_ID_LENGTH || ids.has(file.id)) {
            throw new LunoraError("BAD_REQUEST", "Each rule file needs its own id");
        }

        ids.add(file.id);

        if (!title || title.length > MAX_RULE_TITLE_LENGTH) {
            throw refuse(
                `A rule file's name must be 1 to ${MAX_RULE_TITLE_LENGTH} characters`,
                title ? RULE_FILE_REFUSALS.TITLE_TOO_LONG : RULE_FILE_REFUSALS.TITLE_MISSING,
                file.id,
            );
        }

        if (file.content.length > MAX_RULE_FILE_LENGTH) {
            throw refuse(`A rule file holds at most ${MAX_RULE_FILE_LENGTH} characters`, RULE_FILE_REFUSALS.CONTENT_TOO_LONG, file.id);
        }

        if (file.mode === "always") {
            return { content: file.content, id: file.id, mode: file.mode, title };
        }

        if (file.mode === "auto") {
            const description = (file.description ?? "").trim();

            if (!isRuleDescriptionValid(description)) {
                throw refuse(
                    `A rule file read when needed needs a description of 1 to ${MAX_RULE_DESCRIPTION_LENGTH} characters on one line`,
                    description ? RULE_FILE_REFUSALS.DESCRIPTION_INVALID : RULE_FILE_REFUSALS.DESCRIPTION_MISSING,
                    file.id,
                );
            }

            return { content: file.content, description, id: file.id, mode: file.mode, title };
        }

        const globs = (file.globs ?? []).map((glob) => glob.trim());

        if (globs.length === 0 || globs.length > MAX_RULE_GLOBS) {
            throw refuse(
                `A rule file applied by pattern needs 1 to ${MAX_RULE_GLOBS} patterns`,
                globs.length === 0 ? RULE_FILE_REFUSALS.PATTERNS_MISSING : RULE_FILE_REFUSALS.PATTERNS_TOO_MANY,
                file.id,
            );
        }

        for (const glob of globs) {
            assertGlob(glob, file.id);
        }

        return { content: file.content, globs, id: file.id, mode: file.mode, title };
    });

    if (ruleFilesStoredBytes(normalized) > MAX_RULE_FILES_BYTES) {
        throw refuse("The project's rule files are too large together", RULE_FILE_REFUSALS.TOO_LARGE);
    }

    return normalized;
};
