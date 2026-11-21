/**
 * Rule files from uploaded Markdown: an `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` at the top (of the repository, or of the
 * folder picked) becomes one `always` file under its own name; the files of a rule folder, one of those names included, take their mode from their front matter, read strictly: `alwaysApply: true` → always,
 * else `globs` → applied when files match, else a `description` → read when needed. A file that says none of these is
 * read when needed with no description, which the editor will not save until the person says when, or picks another mode.
 * The text is the file's, front matter removed. Nothing is saved here: the editor adds them as unsaved drafts.
 */
import { isRuleTitleReserved, RULE_FILE_FRONT_MATTER } from "@neore/backend/rule-file-limits";

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

/** A quote at an item's start that no quote across it matches. */
const QUOTE_START = /^["']/u;

/** A block value's header: `|` or `>`, with an optional chomping sign and indentation digit (`>-`, `|+`, `>2`). */
const BLOCK_HEADER = /^[>|][-+1-9]{0,2}$/u;

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

/** Where the quoted item opening at `open` (its quote) ends: after its closing quote; -1 when it does not close in `text`. */
const quotedEnd = (text: string, open: number): number => {
    const quote = text[open];
    let index = open + 1;

    while (index < text.length) {
        const character = text[index];

        if (quote === '"' && character === "\\") {
            index += 2;
        } else if (character !== quote) {
            index += 1;
        } else if (quote === "'" && text[index + 1] === "'") {
            // `''` inside a single-quoted item is one quote.
            index += 2;
        } else {
            return index + 1;
        }
    }

    return -1;
};

/**
 * `text` split at each comma outside a quoted item and outside a `{a,b}` group. Only a quote opening an item and
 * closing in `text` quotes it: `don't/*.md` is one plain pattern.
 */
const splitItems = (text: string): string[] => {
    const items: string[] = [];
    let depth = 0;
    let start = 0;
    let index = 0;

    while (index < text.length) {
        const character = text[index]!;
        // A quote that does not close on this line (a value continued below) quotes nothing: its commas still split.
        const end = (character === '"' || character === "'") && text.slice(start, index).trim() === "" ? quotedEnd(text, index) : -1;

        if (end !== -1) {
            index = end;
            continue;
        }

        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth = Math.max(0, depth - 1);
        } else if (character === "," && depth === 0) {
            items.push(text.slice(start, index));
            start = index + 1;
        }

        index += 1;
    }

    items.push(text.slice(start));

    return items;
};

/**
 * `item` without its quotes, and the quote left open after it: the one closing `open`, what an item before it left
 * open (inside which no other quote counts); else both when it is one quoted scalar, or the quote it opens and leaves
 * open. A quote ending an item nothing
 * opened stays: in `src/it's'` or `a"` it is part of the path.
 */
const openOrClosed = (item: string, open: string | undefined): [text: string, open: string | undefined] => {
    // Inside an open quote every other quote is text: `'a,` then `"b, c'` is `a`, `"b`, `c`.
    if (open) {
        return item.endsWith(open) ? [item.slice(0, -1), undefined] : [item, open];
    }

    if (item !== unquoted(item)) {
        return [unquoted(item), open];
    }

    const opening = QUOTE_START.exec(item)?.[0];

    return opening ? [item.slice(1), opening] : [item, open];
};

/**
 * `[a, b]`, `"a", "b"`, `"a, b"` or `a, b` as its items, quotes dropped. Split at each comma outside a quoted item and
 * outside a `{a,b}` group, so `["src/a,b.ts"]` and `*.{ts,tsx}` each stay one pattern. One quoted string that is the
 * whole value outside brackets is a list of its own (`"a/**, b/*.md"`), as such files write it; a `- item` line
 * (`isItem`) is one item already. `open` is a quote an item on a line before opened and left open, returned with the
 * items as it is after them: only that quote, at an item's end, closes it (`"a/**,` then `b/*.md"`); any other quote at
 * an end is text.
 */
const listOf = (value: string, { isItem = false, open }: { isItem?: boolean; open?: string } = {}): { items: string[]; open: string | undefined } => {
    const trimmed = value.trim();
    // Brackets only around the whole value make it a list: `src/[ab]` is one pattern, its class kept.
    const isBracketed = trimmed.startsWith("[") && trimmed.endsWith("]");
    const items = splitItems(isBracketed ? trimmed.slice(1, -1) : trimmed).map((item) => item.trim());
    const [only] = items;

    if (!isItem && !isBracketed && items.length === 1 && only && only !== unquoted(only)) {
        return {
            items: splitItems(unquoted(only))
                .map((item) => item.trim())
                .filter(Boolean),
            open,
        };
    }

    const texts: string[] = [];
    let left = open;

    for (const item of items) {
        const [text, after] = openOrClosed(item, left);

        texts.push(text.trim());
        left = after;
    }

    return { items: texts.filter(Boolean), open: left };
};

/** The patterns of a `globs:` value's lines, a quote left open on one closed on a later one. */
const globsOf = (parts: string[]): string[] => {
    const patterns: string[] = [];
    let open: string | undefined;

    for (const part of parts) {
        const list = listOf(part, { open });

        patterns.push(...list.items);
        open = list.open;
    }

    return patterns;
};

/** Whether `line` is indented, so it continues the key above it rather than starting one. */
const isIndented = (line: string): boolean => line.startsWith(" ") || line.startsWith("\t");

/**
 * The front matter's top-level `key: value` pairs and the text after it. A value may be quoted, carry a ` #` comment,
 * continue on indented lines, or be a block (`>`, `|`): each is read as one line, its lines joined by a space. A `globs:`
 * list may also be given as `- item` lines after it.
 */
const splitFrontMatter = (text: string): { body: string; fields: Map<string, string[]> } => {
    const match = RULE_FILE_FRONT_MATTER.exec(text);
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
                fields.get(key)!.push(...listOf(item, { isItem: true }).items);
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
        fields.set(key, key === "globs" ? globsOf(parts) : [isBlock ? value : unquoted(value)]);
    }

    // Blank lines, then a `---` rule: a block with text that sets nothing there is the text's own, kept whole. An
    // empty one is front matter all the same, dropped as the repository read counts it.
    if (fields.size === 0 && !match[0].startsWith("-") && (match[1] ?? "").trim() !== "") {
        return { body: text, fields };
    }

    return { body: text.slice(match[0].length), fields };
};

/** Whether `name` (a path's last part) is one of the root instruction files. */
export const isRootInstructionFile = (name: string): boolean => ROOT_INSTRUCTION_FILES.has(name.toLowerCase());

/**
 * Whether the file at `path` (from the top of what was imported) is a root instruction file, imported whole as `always`:
 * the same text elsewhere is read by its front matter, so it makes another rule file.
 */
export const isWholeInstructionFile = (path: string): boolean => !path.replaceAll("\\", "/").includes("/") && isRootInstructionFile(path);

/**
 * One imported file as a rule file, or `null` for one that is not Markdown. `path` is its path from the top of what was
 * imported: only a root instruction file there is `always` whole; in a folder it is read like any rule file.
 */
export const toImportedRuleFile = (path: string, raw: string): ImportedRuleFile | null => {
    const slash = path.replaceAll("\\", "/").lastIndexOf("/");
    const name = path.slice(slash + 1);
    // A byte-order mark would hide the front matter.
    const text = raw.startsWith("\u{FEFF}") ? raw.slice(1) : raw;

    if (isWholeInstructionFile(path)) {
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

/** Whether the UTF-16 unit at `index` of `text` opens a surrogate pair, so a cut there would split a character. */
const isHighSurrogate = (text: string, index: number): boolean => {
    const code = text.codePointAt(index) ?? 0;

    return code > 0xff_ff || (code >= 0xd8_00 && code <= 0xdb_ff);
};

/**
 * `title` as a save takes it: one longer than `max` characters (a file's name, which a save would refuse) cut to fit,
 * never inside a character, and told apart from each of `taken` by ` (2)`, ` (3)`… within `max`, so two long names
 * that start alike stay two. A title that fits is kept as it is, a repeat included, as names may repeat.
 */
export const fitTitle = (title: string, taken: ReadonlySet<string>, max: number): string => {
    if (title.trim().length <= max) {
        return title;
    }

    const cut = (suffix: string): string => {
        const end = max - suffix.length;
        const head = title.slice(0, isHighSurrogate(title, end - 1) ? end - 1 : end).trimEnd();

        return `${head}${suffix}`;
    };

    let candidate = cut("");
    let copy = 1;

    while (taken.has(candidate)) {
        copy += 1;
        candidate = cut(` (${String(copy)})`);
    }

    return candidate;
};

const ID_FORM_OPENING = /^(\s*id):/iu;

/**
 * `title` as a save takes it when it opens the id form (`id:`, {@link isRuleTitleReserved}), which a save refuses for a
 * new name: that opening's colon becomes a hyphen (`id:setup` → `id-setup`), so the file keeps a name that reads as its
 * own. Any other title is kept as it is.
 */
export const unreservedTitle = (title: string): string => (isRuleTitleReserved(title) ? title.replace(ID_FORM_OPENING, "$1-") : title);

/** Whether an imported file said nothing of when it applies: a draft the person must finish before it saves. */
export const needsMode = (file: Pick<ImportedRuleFile, "description" | "mode">): boolean => file.mode === "auto" && file.description.trim() === "";

/** What an import read: each rule file with the path it came from, and the paths past the room (`skipped`). */
export interface ImportedRuleTexts {
    imported: (ImportedRuleFile & { path: string })[];
    skipped: string[];
}

/**
 * The rule files of `entries` (a path, and its text read on demand), in path order, at most `room` of them (those past it
 * in `skipped`), files that are not Markdown left out: the upload ({@link importRuleFiles}) and the repository import
 * share it.
 */
export const importRuleTexts = async (
    entries: ReadonlyArray<{ path: string; text: () => Promise<string> | string }>,
    room: number,
): Promise<ImportedRuleTexts> => {
    const sorted = entries.toSorted((left, right) => left.path.localeCompare(right.path));
    const imported: ImportedRuleTexts["imported"] = [];
    const skipped: string[] = [];

    for (const entry of sorted) {
        // A name alone decides whether it is taken, before its text is read.
        if (toImportedRuleFile(entry.path, "") === null) {
            continue;
        }

        if (imported.length >= room) {
            skipped.push(entry.path);
            continue;
        }

        const ruleFile = toImportedRuleFile(entry.path, await entry.text());

        if (ruleFile) {
            imported.push({ ...ruleFile, path: entry.path });
        }
    }

    return { imported, skipped };
};

/** A picked folder's file by its path in that folder, the folder's own name dropped; a single file by its name. */
const pathInPick = (file: File): string => {
    const path = file.webkitRelativePath;

    return path ? path.slice(path.indexOf("/") + 1) : file.name;
};

/**
 * The rule files of the uploaded `files`, in path order, at most `room` of them: those past it are in `skipped`, files
 * that are not Markdown are left out.
 */
export const importRuleFiles = async (files: ReadonlyArray<File>, room: number): Promise<ImportedRuleTexts> =>
    importRuleTexts(
        files.map((file) => {
            return { path: pathInPick(file), text: () => file.text() };
        }),
        room,
    );
