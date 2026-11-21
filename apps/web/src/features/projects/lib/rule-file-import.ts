/**
 * Rule files from uploaded Markdown: an `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` becomes one `always` file under its own
 * name; the files of a rule folder take their mode from their front matter (`globs` → applied when files match,
 * `description` or `alwaysApply: false` alone → read when needed, `alwaysApply: true` or none of them → always). The
 * text is the file's, front matter removed. Nothing is saved here: the editor adds them as unsaved drafts.
 */

export interface ImportedRuleFile {
    content: string;
    description: string;
    mode: "always" | "auto" | "glob";
    patterns: string;
    title: string;
}

/** The instruction files a project's root holds, by their standard names, imported whole as `always` files. */
const ROOT_INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);

/** The extensions taken from a folder; anything else in it is left out. */
const MARKDOWN_FILE = /\.(?:md|mdc|markdown)$/iu;

const LINE_BREAK = /\r?\n/u;

/** A front-matter key: letters only. */
const KEY = /^[A-Za-z]+$/u;

/** The front matter, an empty block included. */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/u;

/** `[a, b]`, `"a", "b"` or `a, b` as its items, quotes dropped. */
const listOf = (value: string): string[] =>
    value
        .replaceAll(/^\[|\]$/gu, "")
        .split(",")
        .map((item) => item.trim().replaceAll(/^["']|["']$/gu, ""))
        .filter(Boolean);

/** The front matter's one-line `key: value` pairs (a `globs:` list on the lines after it too), and the text after it. */
const splitFrontMatter = (text: string): { body: string; fields: Map<string, string[]> } => {
    const match = FRONT_MATTER.exec(text);
    const fields = new Map<string, string[]>();

    if (!match) {
        return { body: text, fields };
    }

    let key: string | undefined;

    const lines = (match[1] ?? "").split(LINE_BREAK);

    for (const line of lines) {
        const trimmed = line.trim();

        // A `- item` line under the key before it.
        if (trimmed.startsWith("-") && key) {
            fields.get(key)!.push(...listOf(trimmed.slice(1)));
            continue;
        }

        const colon = line.indexOf(":");
        const name = colon > 0 ? line.slice(0, colon).trim() : "";

        key = KEY.test(name) ? name.toLowerCase() : undefined;

        if (key) {
            const value = line.slice(colon + 1).trim();

            // A block value (`>-`, `|`) spans the lines after it, which this does not read: taken as none.
            const single = value.startsWith(">") || value.startsWith("|") ? "" : value.replaceAll(/^["']|["']$/gu, "");

            fields.set(key, key === "globs" ? listOf(value) : [single]);
        }
    }

    return { body: text.slice(match[0].length), fields };
};

/** Whether `name` (a path's last part) is one of the root instruction files. */
export const isRootInstructionFile = (name: string): boolean => ROOT_INSTRUCTION_FILES.has(name.toLowerCase());

/** One uploaded file as a rule file, or `null` for one that is not Markdown. `path` is its name or its path in a folder. */
export const toImportedRuleFile = (path: string, raw: string): ImportedRuleFile | null => {
    const name = path.slice(path.replaceAll("\\", "/").lastIndexOf("/") + 1);
    // A byte-order mark would hide the front matter.
    const text = raw.startsWith("\u{FEFF}") ? raw.slice(1) : raw;

    if (isRootInstructionFile(name)) {
        return { content: text, description: "", mode: "always", patterns: "", title: name };
    }

    if (!MARKDOWN_FILE.test(name)) {
        return null;
    }

    const { body, fields } = splitFrontMatter(text);
    const title = name.replace(MARKDOWN_FILE, "");
    const globs = fields.get("globs") ?? [];
    const description = fields.get("description")?.[0] ?? "";
    const alwaysApply = fields.get("alwaysapply")?.[0]?.toLowerCase();

    if (alwaysApply !== "true" && globs.length > 0) {
        return { content: body, description: "", mode: "glob", patterns: globs.join("\n"), title };
    }

    // One that never applies by itself (`alwaysApply: false`, nothing else) is read when needed; the editor asks when.
    if ((alwaysApply !== "true" && description) || alwaysApply === "false") {
        return { content: body, description, mode: "auto", patterns: "", title };
    }

    return { content: body, description: "", mode: "always", patterns: "", title };
};

/**
 * The rule files of the uploaded `files`, in name order, at most `room` of them: those past it are counted in `skipped`,
 * files that are not Markdown are left out.
 */
export const importRuleFiles = async (files: ReadonlyArray<File>, room: number): Promise<{ imported: ImportedRuleFile[]; skipped: number }> => {
    const pathOf = (file: File): string => file.webkitRelativePath || file.name;
    const sorted = files.toSorted((left, right) => pathOf(left).localeCompare(pathOf(right)));
    const imported: ImportedRuleFile[] = [];
    let skipped = 0;

    for (const file of sorted) {
        // A name alone decides whether it is taken, before its text is read.
        if (toImportedRuleFile(pathOf(file), "") === null) {
            continue;
        }

        if (imported.length >= room) {
            skipped += 1;
            continue;
        }

        const ruleFile = toImportedRuleFile(pathOf(file), await file.text());

        if (ruleFile) {
            imported.push(ruleFile);
        }
    }

    return { imported, skipped };
};
