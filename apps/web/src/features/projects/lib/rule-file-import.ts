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

/** A quote around an item. */
const QUOTE_START = /^["']/u;
const QUOTE_END = /["']$/u;

/** The front matter, an empty block included. */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/u;

/** Where a quoted scalar may open in a value: at its start, or after `[` or `,` in an inline list. */
const QUOTE_OPENS_AFTER = new Set(["", ",", "["]);

/**
 * `value` before a ` #` comment (YAML: a `#` that starts the value or follows a space), outside a quoted scalar. A quote
 * opens one only where a scalar starts, so the apostrophe in `the user's settings` is text.
 */
const withoutComment = (value: string): string => {
    let quote: string | undefined;
    // The last character before this one that is not a space.
    let previous = "";

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!;

        // An escape inside a double-quoted scalar, or `''` inside a single-quoted one: the next character is text, a quote included.
        const escapes = (quote === '"' && character === "\\") || (quote === "'" && character === "'" && value[index + 1] === "'");

        if (escapes) {
            index += 1;
        } else if (quote) {
            quote = character === quote ? undefined : quote;
        } else if ((character === '"' || character === "'") && QUOTE_OPENS_AFTER.has(previous)) {
            quote = character;
        } else if (character === "#" && (index === 0 || value[index - 1] === " " || value[index - 1] === "\t")) {
            return value.slice(0, index).trimEnd();
        }

        if (character !== " " && character !== "\t") {
            previous = character;
        }
    }

    return value;
};

/** A double-quoted scalar's escape: `\"` and `\\` give the character, a line break or tab a space (a value is one line). */
const DOUBLE_QUOTED_ESCAPE = /\\(.)/gu;
const DOUBLED_SINGLE_QUOTE = /''/gu;

const WHITESPACE_ESCAPES = new Set(["n", "r", "t"]);

const unescaped = (character: string): string => (WHITESPACE_ESCAPES.has(character) ? " " : character);

/** One scalar with the quotes around it dropped, and its escapes read: `\"` in a double-quoted one, `''` in a single-quoted one. */
const unquoted = (value: string): string => {
    const trimmed = value.trim();
    const first = trimmed[0];

    if (trimmed.length < 2 || (first !== '"' && first !== "'") || trimmed.at(-1) !== first) {
        return trimmed;
    }

    const inner = trimmed.slice(1, -1);

    return first === '"'
        ? inner.replaceAll(DOUBLE_QUOTED_ESCAPE, (_match, character: string) => unescaped(character))
        : inner.replaceAll(DOUBLED_SINGLE_QUOTE, "'");
};

/**
 * `[a, b]`, `"a", "b"`, `"a, b"` or `a, b` as its items, quotes dropped. Split at each comma outside a `{a,b}` group, so
 * a `*.{ts,tsx}` group stays one pattern and a quoted list of several patterns still gives each.
 */
const listOf = (value: string): string[] => {
    const trimmed = value.trim();
    // Brackets only around the whole value make it a list: `src/[ab]` is one pattern, its class kept.
    const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    const items: string[] = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index < inner.length; index += 1) {
        const character = inner[index];

        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth = Math.max(0, depth - 1);
        } else if (character === "," && depth === 0) {
            items.push(inner.slice(start, index));
            start = index + 1;
        }
    }

    items.push(inner.slice(start));

    // A quote that opened or closed a whole quoted list is left on its first or last item.
    return items.map((item) => item.trim().replace(QUOTE_START, "").replace(QUOTE_END, "")).filter(Boolean);
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

        // Patterns are read line by line: a block or continued `globs:` value gives one or more on each line.
        fields.set(key, key === "globs" ? parts.flatMap((part) => listOf(part)) : [isBlock ? value : unquoted(value)]);
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
    // Only `true` or `false`, quoted or not, in any case: any other value says nothing, so the file is not applied to every chat.
    const alwaysApply = fields.get("alwaysapply")?.[0]?.trim().toLowerCase();

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
