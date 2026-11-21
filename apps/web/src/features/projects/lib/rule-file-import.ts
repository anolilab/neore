/**
 * Rule files from uploaded Markdown: an `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` becomes one `always` file under its own
 * name; the files of a rule folder take their mode from their front matter, read strictly: `alwaysApply: true` → always,
 * else `globs` → applied when files match, else a `description` → read when needed. A file that says none of these is
 * read when needed with no description, which the editor will not save until the person says when, or picks another mode.
 * The text is the file's, front matter removed. Nothing is saved here: the editor adds them as unsaved drafts.
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

/** A block value's header: `|` or `>`, with an optional chomping sign and indentation digit (`>-`, `|+`, `>2`). */
const BLOCK_HEADER = /^[>|][-+1-9]{0,2}$/u;

/** The brackets around an inline list. */
const LIST_OPEN = /^\[/u;
const LIST_CLOSE = /\]$/u;

/** The front matter, an empty block included. */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/u;

/** `value` before a ` #` comment outside quotes (YAML: a `#` that starts the value or follows a space). */
const withoutComment = (value: string): string => {
    let quote: string | undefined;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];

        if (quote) {
            if (character === quote) {
                quote = undefined;
            }
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === "#" && (index === 0 || value[index - 1] === " " || value[index - 1] === "\t")) {
            return value.slice(0, index).trimEnd();
        }
    }

    return value;
};

/** One scalar with the quotes around it dropped. */
const unquoted = (value: string): string => {
    const trimmed = value.trim();
    const first = trimmed[0];

    return trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.at(-1) === first ? trimmed.slice(1, -1) : trimmed;
};

/**
 * `[a, b]`, `"a", "b"` or `a, b` as its items, quotes dropped. A comma inside quotes or a `{a,b}` group is part of the
 * item, so a `*.{ts,tsx}` group stays one pattern.
 */
const listOf = (value: string): string[] => {
    const inner = value.trim().replace(LIST_OPEN, "").replace(LIST_CLOSE, "");
    const items: string[] = [];
    let depth = 0;
    let quote: string | undefined;
    let start = 0;

    for (let index = 0; index < inner.length; index += 1) {
        const character = inner[index];

        if (quote) {
            quote = character === quote ? undefined : quote;
            continue;
        }

        switch (character) {
            case '"':
            case "'": {
                quote = character;
                break;
            }
            case ",": {
                if (depth === 0) {
                    items.push(inner.slice(start, index));
                    start = index + 1;
                }

                break;
            }
            case "{": {
                depth += 1;
                break;
            }
            case "}": {
                depth = Math.max(0, depth - 1);
                break;
            }
            default: {
                break;
            }
        }
    }

    items.push(inner.slice(start));

    return items.map((item) => unquoted(item)).filter(Boolean);
};

/** Whether `line` is indented, so it continues the key above it rather than starting one. */
const isIndented = (line: string): boolean => line.startsWith(" ") || line.startsWith("\t");

/**
 * The front matter's top-level `key: value` pairs and the text after it. A value may be quoted, carry a ` #` comment,
 * continue on indented lines, or be a block (`>`, `|`): each is read as one line, its lines joined by a space. A `globs:`
 * list may also be given as `- item` lines after it.
 */
const splitFrontMatter = (text: string): { body: string; fields: Map<string, string[]> } => {
    const match = FRONT_MATTER.exec(text);
    const fields = new Map<string, string[]>();

    if (!match) {
        return { body: text, fields };
    }

    const lines = (match[1] ?? "").split(LINE_BREAK);
    let key: string | undefined;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const trimmed = line.trim();

        if (trimmed === "" || trimmed.startsWith("#")) {
            continue;
        }

        // A `- item` line under the key before it.
        if (trimmed.startsWith("- ") || trimmed === "-") {
            const item = withoutComment(trimmed.slice(1));

            if (key) {
                fields.get(key)!.push(...listOf(item));
            }

            continue;
        }

        // An indented line that is no list item belongs to a value read below; anything else nested is not ours.
        if (isIndented(line)) {
            continue;
        }

        const colon = line.indexOf(":");
        const name = colon > 0 ? line.slice(0, colon).trim() : "";

        key = KEY.test(name) ? name.toLowerCase() : undefined;

        if (!key) {
            continue;
        }

        const head = withoutComment(line.slice(colon + 1).trim());
        const isBlock = BLOCK_HEADER.test(head);
        const parts = isBlock ? [] : [head];

        // The value's own lines: indented (or blank, inside a block), never a list item.
        while (index + 1 < lines.length) {
            const next = lines[index + 1]!;
            const nextTrimmed = next.trim();

            const isItem = nextTrimmed.startsWith("- ") || nextTrimmed === "-";
            // A block takes blank lines and anything indented; a plain value stops at a blank, a list item or a comment.
            const continues = isBlock
                ? nextTrimmed === "" || isIndented(next)
                : nextTrimmed !== "" && isIndented(next) && !isItem && !nextTrimmed.startsWith("#");

            if (!continues) {
                break;
            }

            parts.push(isBlock ? nextTrimmed : withoutComment(nextTrimmed));
            index += 1;
        }

        const value = parts.filter(Boolean).join(" ");

        fields.set(key, key === "globs" ? listOf(value) : [isBlock ? value : unquoted(value)]);
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
    // Only YAML's own booleans: any other value says nothing.
    const alwaysApply = fields.get("alwaysapply")?.[0]?.toLowerCase();

    if (alwaysApply === "true") {
        return { content: body, description: "", mode: "always", patterns: "", title };
    }

    if (globs.length > 0) {
        return { content: body, description: "", mode: "glob", patterns: globs.join("\n"), title };
    }

    // Read when needed; with no description it waits for the person to say when (`needsMode`).
    return { content: body, description, mode: "auto", patterns: "", title };
};

/** Whether an imported file said nothing of when it applies: a draft the person must finish before it saves. */
export const needsMode = (file: Pick<ImportedRuleFile, "description" | "mode">): boolean => file.mode === "auto" && file.description.trim() === "";

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
