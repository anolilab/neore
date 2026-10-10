/**
 * SKILL.md import and export — pure, shared by the backend (`skills/io.ts`,
 * authoritative) and the web client (preview and `.zip` packing), through the
 * `@neore/backend/skills/markdown` export. No server imports here.
 *
 * The format is the Agent Skills `SKILL.md` (agentskills.io, used by Claude):
 * YAML frontmatter, then the instructions as the markdown body.
 *
 * - `name` is the spec's identifier (lowercase, hyphens) — our `slug`.
 * - `description` is required by the spec and by us.
 * - `allowed-tools` (space-delimited, per the spec) carries `additionalTools`;
 *   `tools` is read as an alias. `model` (a Claude Code extension) carries
 *   `preferredModel`.
 * - Everything the spec has no field for goes under `metadata`, which the spec
 *   defines as a string → string map — so a stricter validator than ours still
 *   accepts what we export. `variables` is JSON in a string for that reason.
 *
 * The YAML reader is a deliberate subset (scalars, quoted strings, block
 * scalars, flow and block lists, one nested map): enough for what the format
 * uses, and no parser dependency in the client bundle.
 */

export const SKILL_MARKDOWN_FILE = "SKILL.md";

/** Caps an import is checked against — the editor's own limits, plus the file budget. */
export const SKILL_IMPORT_LIMITS = {
    /** Matches `SKILL_DESCRIPTION_MAX` in the editor and `MAX_DESCRIPTION_LENGTH`. */
    description: 1024,
    /** Per-file ceilings by type, as `FILE_SIZE_LIMITS` in `skills/constants.ts`. */
    fileBytes: { asset: 2 * 1024 * 1024, reference: 512 * 1024, script: 1024 * 1024 },
    files: 50,
    /** Matches `SKILL_INSTRUCTIONS_MAX` in the editor. */
    instructions: 10_000,
    markdownBytes: 64 * 1024,
    name: 100,
    /** Sum of every additional file, decoded. Keeps one import inside a single RPC body. */
    totalFileBytes: 4 * 1024 * 1024,
} as const;

export interface SkillVariableData {
    defaultValue?: string;
    description?: string;
    name: string;
    required?: boolean;
}

export interface SkillConfigData {
    additionalTools?: string[];
    disabledTools?: string[];
    preferredModel?: string;
    reasoningEffort?: number;
    searchMode?: string;
}

/** The skill fields SKILL.md carries, in and out. */
export interface SkillMarkdownData {
    category?: string;
    config?: SkillConfigData;
    description: string;
    icon?: string;
    instructions: string;
    name: string;
    slug: string;
    tags?: string[];
    variables?: SkillVariableData[];
    version?: string;
}

export type SkillFileType = "asset" | "reference" | "script";

export interface SkillFileData {
    /** `utf8` for text, `base64` for anything else. */
    content: string;
    encoding: "base64" | "utf8";
    /** Relative to the skill's directory, `/`-separated (`references/api.md`). */
    path: string;
}

export type ParseSkillResult = { errors: string[]; ok: false } | { ok: true; skill: SkillMarkdownData; warnings: string[] };

// ─── YAML subset ─────────────────────────────────────────────────────────────

type YamlValue = Record<string, string> | string | string[];

const FRONTMATTER_RE = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const KEY_LINE_RE = /^([A-Z_][\w.-]*)[ \t]*:(?:[ \t](.*))?$/i;
const LIST_ITEM_RE = /^-(?:[ \t](.*))?$/;
const BLOCK_SCALAR_RE = /^([|>])([+-]?)\d*[ \t]*$/;
const COMMENT_START_RE = /[ \t]#/;
const LEADING_SPACES_RE = /^ */;
const INDICATOR_START_RE = /^[\s!"#%&'*,>?@[\]`{|}-]/;
const UNSAFE_END_RE = /[\s:]$/;
const RESERVED_SCALAR_RE = /^(?:true|false|yes|no|on|off|null|~)$/i;
const NUMERIC_START_RE = /^[+-]?\d/;
const LINE_BREAK_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/;
const SLUG_CLEAN_RE = /[^a-z0-9]+/g;

/** Drops leading and trailing hyphens (a loop, not a regex: `/^-+|-+$/` backtracks). */
const trimHyphens = (value: string): string => {
    let start = 0;
    let end = value.length;

    while (start < end && value[start] === "-") {
        start += 1;
    }

    while (end > start && value[end - 1] === "-") {
        end -= 1;
    }

    return value.slice(start, end);
};

const indentOf = (line: string): number => LEADING_SPACES_RE.exec(line)![0].length;

const unquote = (raw: string): string => {
    const value = raw.trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        try {
            return JSON.parse(value) as string;
        } catch {
            return value.slice(1, -1);
        }
    }

    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        return value.slice(1, -1).replaceAll("''", "'");
    }

    const comment = COMMENT_START_RE.exec(value);

    return (comment ? value.slice(0, comment.index) : value).trim();
};

const parseFlowList = (raw: string): string[] =>
    raw
        .trim()
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item))
        .filter((item) => item.length > 0);

/** Reads a block scalar (`|` keeps newlines, `>` folds them) whose lines are indented past `parentIndent`. */
const readBlockScalar = (lines: string[], start: number, parentIndent: number, style: string, chomp: string): { next: number; value: string } => {
    const collected: string[] = [];
    let index = start;
    let blockIndent: number | undefined;

    for (; index < lines.length; index += 1) {
        const line = lines[index]!;

        if (line.trim() === "") {
            collected.push("");
            continue;
        }

        const indent = indentOf(line);

        if (indent <= parentIndent) {
            break;
        }

        blockIndent ??= indent;
        collected.push(line.slice(Math.min(indent, blockIndent)));
    }

    while (collected.length > 0 && collected.at(-1) === "") {
        collected.pop();
    }

    let value = "";

    if (style === "|") {
        value = collected.join("\n");
    } else {
        for (const line of collected) {
            if (line === "") {
                value += "\n";
            } else {
                value += value === "" || value.endsWith("\n") ? line : ` ${line}`;
            }
        }
    }

    // Clip and strip both end without a newline here: every field is trimmed on read.
    return { next: index, value: chomp === "+" ? `${value}\n` : value };
};

/**
 * Parses the frontmatter subset: top-level keys whose value is a scalar, a
 * block scalar, a flow list, a block list, or a one-level map.
 */
export const parseFrontmatterYaml = (source: string): Record<string, YamlValue> => {
    const lines = source.split(LINE_BREAK_RE);
    const result: Record<string, YamlValue> = {};
    let index = 0;

    while (index < lines.length) {
        const line = lines[index]!;

        if (line.trim() === "" || line.trimStart().startsWith("#") || indentOf(line) > 0) {
            index += 1;
            continue;
        }

        const match = KEY_LINE_RE.exec(line.trimEnd());

        if (!match) {
            throw new Error(`Unreadable frontmatter line ${String(index + 1)}: "${line.slice(0, 60)}"`);
        }

        const key = match[1]!;
        const rest = (match[2] ?? "").trim();

        index += 1;

        const block = BLOCK_SCALAR_RE.exec(rest);

        if (block) {
            const read = readBlockScalar(lines, index, 0, block[1]!, block[2]!);

            result[key] = read.value;
            index = read.next;
            continue;
        }

        if (rest.startsWith("[") && rest.endsWith("]")) {
            result[key] = parseFlowList(rest);
            continue;
        }

        if (rest !== "" && !rest.startsWith("#")) {
            result[key] = unquote(rest);
            continue;
        }

        // A nested block: a list (`- item`) or a map (`child: value`), one level deep.
        const items: string[] = [];
        const map: Record<string, string> = {};
        let isList = false;

        while (index < lines.length) {
            const child = lines[index]!;

            if (child.trim() === "" || child.trimStart().startsWith("#")) {
                index += 1;
                continue;
            }

            const childIndent = indentOf(child);

            if (childIndent === 0) {
                break;
            }

            const trimmed = child.trim();
            const listItem = LIST_ITEM_RE.exec(trimmed);

            index += 1;

            if (listItem) {
                isList = true;
                items.push(unquote(listItem[1] ?? ""));
                continue;
            }

            const childMatch = KEY_LINE_RE.exec(trimmed);

            if (!childMatch) {
                throw new Error(`Unreadable frontmatter line ${String(index)}: "${child.slice(0, 60)}"`);
            }

            const childRest = (childMatch[2] ?? "").trim();
            const childBlock = BLOCK_SCALAR_RE.exec(childRest);

            if (childBlock) {
                const read = readBlockScalar(lines, index, childIndent, childBlock[1]!, childBlock[2]!);

                map[childMatch[1]!] = read.value;
                index = read.next;
            } else {
                map[childMatch[1]!] = childRest.startsWith("[") && childRest.endsWith("]") ? parseFlowList(childRest).join(", ") : unquote(childRest);
            }
        }

        result[key] = isList ? items : map;
    }

    return result;
};

/** A YAML scalar that reads back as the same string: plain when safe, JSON-quoted otherwise. */
const needsQuotes = (value: string): boolean =>
    value === "" ||
    value.includes("\n") ||
    value.includes(": ") ||
    value.includes(" #") ||
    INDICATOR_START_RE.test(value) ||
    UNSAFE_END_RE.test(value) ||
    RESERVED_SCALAR_RE.test(value) ||
    NUMERIC_START_RE.test(value);

const yamlString = (value: string): string => (needsQuotes(value) ? JSON.stringify(value) : value);

// ─── Export ──────────────────────────────────────────────────────────────────

const joinTools = (tools: ReadonlyArray<string> | undefined): string | undefined => {
    const list = (tools ?? []).map((tool) => tool.trim()).filter(Boolean);

    return list.length > 0 ? list.join(" ") : undefined;
};

/** A skill as SKILL.md: frontmatter, a blank line, the instructions. */
export const skillToMarkdown = (skill: SkillMarkdownData): string => {
    const lines = ["---", `name: ${yamlString(skill.slug)}`, `description: ${yamlString(skill.description)}`];
    const { config } = skill;

    if (config?.preferredModel) {
        lines.push(`model: ${yamlString(config.preferredModel)}`);
    }

    const allowedTools = joinTools(config?.additionalTools);

    if (allowedTools) {
        lines.push(`allowed-tools: ${yamlString(allowedTools)}`);
    }

    const metadata: [string, string | undefined][] = [
        ["display-name", skill.name],
        ["version", skill.version],
        ["category", skill.category],
        ["icon", skill.icon],
        ["tags", skill.tags && skill.tags.length > 0 ? skill.tags.join(", ") : undefined],
        ["disabled-tools", joinTools(config?.disabledTools)],
        ["reasoning-effort", config?.reasoningEffort === undefined ? undefined : String(config.reasoningEffort)],
        ["search-mode", config?.searchMode],
        ["variables", skill.variables && skill.variables.length > 0 ? JSON.stringify(skill.variables) : undefined],
    ];
    const present = metadata.filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "");

    if (present.length > 0) {
        lines.push("metadata:");

        for (const [key, value] of present) {
            lines.push(`  ${key}: ${yamlString(value)}`);
        }
    }

    lines.push("---", "", skill.instructions.trim(), "");

    return lines.join("\n");
};

// ─── Import ──────────────────────────────────────────────────────────────────

/** Lowercase-hyphen identifier from any name, the way the editor derives slugs. */
export const toSkillSlug = (value: string): string =>
    trimHyphens(trimHyphens(value.normalize("NFKD").toLowerCase().replaceAll(SLUG_CLEAN_RE, "-")).slice(0, 64));

const titleFromSlug = (slug: string): string =>
    slug
        .split("-")
        .filter(Boolean)
        .map((word) => word[0]!.toUpperCase() + word.slice(1))
        .join(" ");

const asString = (value: YamlValue | undefined): string | undefined => (typeof value === "string" ? value.trim() || undefined : undefined);

const asList = (value: YamlValue | undefined): string[] | undefined => {
    if (Array.isArray(value)) {
        return value.map((item) => item.trim()).filter(Boolean);
    }

    if (typeof value === "string") {
        // The spec's `allowed-tools` is space-delimited; commas are common in the wild.
        return value
            .split(value.includes(",") ? "," : WHITESPACE_RE)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return undefined;
};

const parseVariables = (raw: string | undefined, warnings: string[]): SkillVariableData[] | undefined => {
    if (!raw) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        if (!Array.isArray(parsed)) {
            throw new TypeError("not a list");
        }

        const variables = parsed.flatMap((item): SkillVariableData[] => {
            if (!item || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string") {
                return [];
            }

            const { defaultValue, description, name, required } = item as Record<string, unknown>;

            return [
                {
                    name: (name as string).trim(),
                    ...(typeof defaultValue === "string" && { defaultValue }),
                    ...(typeof description === "string" && { description }),
                    ...(typeof required === "boolean" && { required }),
                },
            ];
        });

        return variables.filter((variable) => variable.name.length > 0);
    } catch {
        warnings.push("metadata.variables is not a JSON list of variables and was ignored");

        return undefined;
    }
};

/**
 * Reads a SKILL.md. Structural problems (no frontmatter, no name or
 * description, over a cap) are errors; anything merely unusable is dropped
 * with a warning, so a skill written for another host still imports.
 */
export const parseSkillMarkdown = (markdown: string): ParseSkillResult => {
    if (new TextEncoder().encode(markdown).length > SKILL_IMPORT_LIMITS.markdownBytes) {
        return { errors: [`SKILL.md is larger than ${String(SKILL_IMPORT_LIMITS.markdownBytes / 1024)} KB`], ok: false };
    }

    const match = FRONTMATTER_RE.exec(markdown);

    if (!match) {
        return { errors: ["SKILL.md must start with YAML frontmatter between --- lines"], ok: false };
    }

    let frontmatter: Record<string, YamlValue>;

    try {
        frontmatter = parseFrontmatterYaml(match[1]!);
    } catch (error) {
        return { errors: [error instanceof Error ? error.message : "Unreadable frontmatter"], ok: false };
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object" && !Array.isArray(frontmatter.metadata) ? frontmatter.metadata : {};
    const rawName = asString(frontmatter.name);
    const description = asString(frontmatter.description);
    const instructions = markdown.slice(match[0].length).trim();

    if (!rawName) {
        errors.push("Field 'name' is required");
    }

    if (!description) {
        errors.push("Field 'description' is required");
    } else if (description.length > SKILL_IMPORT_LIMITS.description) {
        errors.push(`Description must be ${String(SKILL_IMPORT_LIMITS.description)} characters or less`);
    }

    if (!instructions) {
        errors.push("The instructions (the markdown after the frontmatter) are empty");
    } else if (instructions.length > SKILL_IMPORT_LIMITS.instructions) {
        errors.push(`Instructions must be ${String(SKILL_IMPORT_LIMITS.instructions)} characters or less (found ${String(instructions.length)})`);
    }

    const slug = rawName ? toSkillSlug(rawName) : "";

    if (rawName && !slug) {
        errors.push("Field 'name' has no letters or digits to build an identifier from");
    }

    if (errors.length > 0) {
        return { errors, ok: false };
    }

    const name = (metadata["display-name"]?.trim() || (rawName && rawName !== slug ? rawName : titleFromSlug(slug))).slice(0, SKILL_IMPORT_LIMITS.name);

    const reasoningRaw = metadata["reasoning-effort"];
    const reasoningEffort = reasoningRaw === undefined ? undefined : Number(reasoningRaw);
    const config: SkillConfigData = {};
    const preferredModel = asString(frontmatter.model);
    const additionalTools = asList(frontmatter["allowed-tools"] ?? frontmatter.tools);
    const disabledTools = asList(metadata["disabled-tools"]);

    if (preferredModel && preferredModel !== "inherit") {
        config.preferredModel = preferredModel;
    }

    if (additionalTools && additionalTools.length > 0) {
        config.additionalTools = additionalTools;
    }

    if (disabledTools && disabledTools.length > 0) {
        config.disabledTools = disabledTools;
    }

    if (reasoningEffort !== undefined) {
        if (Number.isSafeInteger(reasoningEffort) && reasoningEffort >= 0 && reasoningEffort <= 4) {
            config.reasoningEffort = reasoningEffort;
        } else {
            warnings.push("metadata.reasoning-effort must be a whole number from 0 to 4 and was ignored");
        }
    }

    if (metadata["search-mode"]) {
        config.searchMode = metadata["search-mode"];
    }

    const tags = asList(metadata.tags);
    const variables = parseVariables(metadata.variables, warnings);

    return {
        ok: true,
        skill: {
            description: description!,
            instructions,
            name,
            slug,
            ...(Object.keys(config).length > 0 && { config }),
            ...(metadata.category && { category: metadata.category }),
            ...(metadata.icon && { icon: metadata.icon }),
            ...(tags && tags.length > 0 && { tags: tags.map((tag) => tag.toLowerCase()) }),
            ...(variables && variables.length > 0 && { variables }),
            ...(metadata.version && { version: metadata.version }),
        },
        warnings,
    };
};

// ─── Additional files ────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
    "bash",
    "c",
    "cfg",
    "conf",
    "cpp",
    "css",
    "csv",
    "go",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsx",
    "md",
    "mjs",
    "py",
    "rb",
    "rs",
    "sh",
    "sql",
    "svg",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml",
]);
const SCRIPT_EXTENSIONS = new Set(["bash", "js", "mjs", "py", "rb", "sh", "ts"]);

const extensionOf = (path: string): string => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");

    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** Whether a path is read and shipped as UTF-8 text rather than base64. */
export const isTextSkillFile = (path: string): boolean => TEXT_EXTENSIONS.has(extensionOf(path));

/** The spec's directories decide first (`scripts/`, `references/`, `assets/`), then the extension. */
export const classifySkillFile = (path: string): SkillFileType => {
    const top = path.split("/", 1)[0]?.toLowerCase();

    if (top === "scripts") {
        return "script";
    }

    if (top === "references") {
        return "reference";
    }

    if (top === "assets") {
        return "asset";
    }

    const extension = extensionOf(path);

    if (SCRIPT_EXTENSIONS.has(extension)) {
        return "script";
    }

    return TEXT_EXTENSIONS.has(extension) ? "reference" : "asset";
};

/**
 * A relative path inside the skill, or `undefined` for anything that could
 * escape it or is not a real file (absolute, `..`, hidden, OS litter).
 */
export const normalizeSkillFilePath = (path: string): string | undefined => {
    const segments = path
        .replaceAll("\\", "/")
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".");

    if (segments.length === 0 || path.startsWith("/") || segments.some((segment) => segment === ".." || segment.startsWith(".") || segment === "__MACOSX")) {
        return undefined;
    }

    const normalized = segments.join("/");

    return normalized.length <= 512 ? normalized : undefined;
};

/** Decoded size of a file's content. */
export const skillFileBytes = (file: Pick<SkillFileData, "content" | "encoding">): number => {
    if (file.encoding === "utf8") {
        return new TextEncoder().encode(file.content).length;
    }

    let padding = 0;

    if (file.content.endsWith("==")) {
        padding = 2;
    } else if (file.content.endsWith("=")) {
        padding = 1;
    }

    return Math.floor((file.content.length * 3) / 4) - padding;
};

/** Checks the additional files against {@link SKILL_IMPORT_LIMITS}; returns the problems, empty when fine. */
export const validateSkillFiles = (files: ReadonlyArray<SkillFileData>): string[] => {
    const errors: string[] = [];
    const seen = new Set<string>();
    let total = 0;

    if (files.length > SKILL_IMPORT_LIMITS.files) {
        errors.push(`A skill can carry at most ${String(SKILL_IMPORT_LIMITS.files)} additional files (found ${String(files.length)})`);
    }

    for (const file of files) {
        const path = normalizeSkillFilePath(file.path);

        if (!path || path !== file.path) {
            errors.push(`Invalid file path: ${file.path}`);
            continue;
        }

        if (path === SKILL_MARKDOWN_FILE) {
            errors.push(`${SKILL_MARKDOWN_FILE} is the skill itself, not an additional file`);
            continue;
        }

        if (seen.has(path)) {
            errors.push(`Duplicate file: ${path}`);
            continue;
        }

        seen.add(path);

        const bytes = skillFileBytes(file);
        const cap = SKILL_IMPORT_LIMITS.fileBytes[classifySkillFile(path)];

        total += bytes;

        if (bytes > cap) {
            errors.push(`${path} is ${String(Math.ceil(bytes / 1024))} KB; the limit for this kind of file is ${String(cap / 1024)} KB`);
        }
    }

    if (total > SKILL_IMPORT_LIMITS.totalFileBytes) {
        errors.push(`Additional files add up to more than ${String(SKILL_IMPORT_LIMITS.totalFileBytes / 1024 / 1024)} MB`);
    }

    return errors;
};

/**
 * Splits an archive's entries into the SKILL.md and the files beside it. The
 * SKILL.md may sit at the root or in one top-level folder (`my-skill/SKILL.md`,
 * how skills are usually zipped); the other files are made relative to it.
 */
export const locateSkillInArchive = <T extends { path: string }>(
    entries: ReadonlyArray<T>,
): { errors: string[]; files: T[]; ok: false } | { files: T[]; ok: true; skill: T } => {
    const usable = entries.filter((entry) => normalizeSkillFilePath(entry.path) !== undefined);
    const candidates = usable.filter((entry) => entry.path.split("/").at(-1)?.toUpperCase() === SKILL_MARKDOWN_FILE.toUpperCase());
    const shallowest = candidates.toSorted((a, b) => a.path.split("/").length - b.path.split("/").length)[0];

    if (!shallowest || shallowest.path.split("/").length > 2) {
        return { errors: [`No ${SKILL_MARKDOWN_FILE} at the top of the archive (or in one top-level folder)`], files: [], ok: false };
    }

    if (candidates.filter((entry) => entry.path.split("/").length === shallowest.path.split("/").length).length > 1) {
        return { errors: [`The archive holds more than one skill; import them one at a time`], files: [], ok: false };
    }

    const prefix = shallowest.path.slice(0, shallowest.path.length - shallowest.path.split("/").at(-1)!.length);
    const files = usable
        .filter((entry) => entry !== shallowest && entry.path.startsWith(prefix))
        .map((entry) => {
            return { ...entry, path: entry.path.slice(prefix.length) };
        });

    return { files, ok: true, skill: shallowest };
};
