/**
 * The team bundle: a chosen set of skills, schedules / webhooks and group chats
 * as ONE Markdown file. Pure — nothing here talks to the database, so the
 * format is unit-tested directly; `bundle-plan.ts` decides what an import
 * would do and `bundle.ts` holds the procedures.
 *
 * ```
 * ---
 * bundle: 1
 * name: Team starter
 * description: …
 * ---
 *
 * ## skill: paper-summary
 *
 * ````markdown
 * <the skill's SKILL.md, see markdown.ts>
 * ````
 *
 * ## trigger: Weekly digest
 *
 * ```json
 * { "type": "schedule", … }
 * ```
 * ```
 *
 * One section per item: a `## <kind>: <label>` heading and exactly one fenced
 * block. The heading is for people; the parser reads the block. Every block is
 * fenced with more backticks than the longest run inside it, and the parser
 * follows fence state line by line, so a `## ` heading (or a fence) inside an
 * embedded SKILL.md is content, never a new item.
 *
 * Everything an export writes is picked from a whitelist of fields. Whatever
 * a row carries beyond it — secrets, owners, organization, bot, enabled — never
 * reaches the file, and an import reads only the same whitelist back, so a
 * hand-edited file cannot smuggle `enabled: true` or a `webhookSecret` in.
 */
import { parseCustomModelId } from "@neore/ai/models";

import { MAX_LENGTH } from "../lib/validators";
import { FILTER_OPS, MAX_FILTERS } from "../triggers/filters";
import type { SkillConfigData, SkillMarkdownData, SkillVariableData } from "./markdown";
import { FRONTMATTER_RE, parseFrontmatterYaml, parseSkillMarkdown, skillToMarkdown, yamlString } from "./markdown";

export const BUNDLE_VERSION = 1;

/**
 * The caps. The per-kind counts sit below the smallest window of the create
 * procedure each kind goes through (`skills/create` 10 a minute,
 * `triggers/create` 5, `chat/create` 20 on the free tier), so a valid bundle
 * does not hit a 429 halfway through an import. They are per kind, because each
 * create charges its own family; `bundle-plan.test.ts` pins them against the
 * rate-limit table.
 */
export const BUNDLE_LIMITS = {
    bytes: 512 * 1024,
    description: 1024,
    groupChats: 9,
    itemBytes: 64 * 1024,
    name: 100,
    skills: 9,
    triggers: 4,
} as const;

export type BundleItemKind = "group" | "skill" | "trigger";

export type BundleGroupMode = "debate" | "mention-only" | "parallel" | "round-robin" | "supervisor";

export const BUNDLE_GROUP_MODES: ReadonlyArray<BundleGroupMode> = ["supervisor", "round-robin", "mention-only", "parallel", "debate"];

export type BundleWebhookScheme = "gitlab-token" | "native" | "timestamped";

const WEBHOOK_SCHEMES: ReadonlyArray<BundleWebhookScheme> = ["timestamped", "native", "gitlab-token"];

export interface BundleFilter {
    op: (typeof FILTER_OPS)[number];
    path: string;
    value?: string;
}

/** A schedule or webhook trigger, as the file carries it. Never enabled, never with a secret. */
export interface BundleTrigger {
    cronExpression?: string;
    description?: string;
    filters?: BundleFilter[];
    inputTemplate?: string;
    model: string;
    name: string;
    searchMode?: string;
    systemPrompt?: string;
    timezone?: string;
    type: "schedule" | "webhook";
    webhookSignatureScheme?: BundleWebhookScheme;
}

/** A group chat setup; participants are skill slugs, resolved against the skills in the same file. */
export interface BundleGroup {
    debateRounds?: number;
    mode: BundleGroupMode;
    model: string;
    participants: string[];
    synthesizer?: string;
    title: string;
}

export type BundleItem = { group: BundleGroup; kind: "group" } | { kind: "skill"; skill: SkillMarkdownData } | { kind: "trigger"; trigger: BundleTrigger };

export interface Bundle {
    description: string;
    items: BundleItem[];
    name: string;
}

/** One section as read: the item, or the problems that keep it from being one. */
export interface BundleEntry {
    index: number;
    item?: BundleItem;
    kind: BundleItemKind;
    label: string;
    problems: string[];
    warnings: string[];
}

export interface ParsedBundle {
    description: string;
    entries: BundleEntry[];
    name: string;
}

export type ParseBundleResult = { bundle: ParsedBundle; ok: true } | { errors: string[]; ok: false };

const SKILL_FENCE_INFO = "markdown";
const JSON_FENCE_INFO = "json";
const HEADING_RE = /^## ([a-z]+):(?: (.*))?$/;
const OPEN_FENCE_RE = /^(`{3,})[^\s`]*[ \t]*$/;
const CLOSE_FENCE_RE = /^(`{3,})[ \t]*$/;
const BACKTICK_RUN_RE = /`+/g;
const WHITESPACE_RE = /\s+/g;
const LINE_BREAK_RE = /\r\n?/g;
const NON_ICON_RE = /[:/@\\]/;
const KINDS: ReadonlyArray<BundleItemKind> = ["skill", "trigger", "group"];

/** Strings a trigger or group carries, with the longest the file may hold. */
const FIELD_CAPS = { cron: 200, description: MAX_LENGTH.long, label: 500, model: 200, short: 500, text: 60_000, timezone: 100 } as const;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const singleLine = (text: string, max: number): string => text.replaceAll(WHITESPACE_RE, " ").trim().slice(0, max);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCustomModel = (model: string): boolean => model.startsWith("custom:") || parseCustomModelId(model) !== null;

// ─── Writing ─────────────────────────────────────────────────────────────────

const fenceFor = (content: string): string => {
    const longest = Math.max(0, ...[...content.matchAll(BACKTICK_RUN_RE)].map((run) => run[0].length));

    return "`".repeat(Math.max(3, longest + 1));
};

const withoutTrailingNewlines = (text: string): string => {
    let end = text.length;

    while (end > 0 && text[end - 1] === "\n") {
        end -= 1;
    }

    return text.slice(0, end);
};

const section = (kind: BundleItemKind, label: string, info: string, content: string): string => {
    const fence = fenceFor(content);

    return [`## ${kind}: ${singleLine(label, 100)}`, "", `${fence}${info}`, withoutTrailingNewlines(content), fence, ""].join("\n");
};

const triggerJson = (trigger: BundleTrigger): string => {
    const isSchedule = trigger.type === "schedule";
    const picked: Record<string, unknown> = {
        ...(isSchedule && trigger.cronExpression !== undefined && { cronExpression: trigger.cronExpression }),
        ...(trigger.description !== undefined && { description: trigger.description }),
        ...(!isSchedule &&
            trigger.filters &&
            trigger.filters.length > 0 && {
                filters: trigger.filters.map((f) => {
                    return { op: f.op, path: f.path, ...(f.value !== undefined && { value: f.value }) };
                }),
            }),
        ...(trigger.inputTemplate !== undefined && { inputTemplate: trigger.inputTemplate }),
        model: trigger.model,
        name: trigger.name,
        ...(trigger.searchMode !== undefined && { searchMode: trigger.searchMode }),
        ...(trigger.systemPrompt !== undefined && { systemPrompt: trigger.systemPrompt }),
        ...(isSchedule && trigger.timezone !== undefined && { timezone: trigger.timezone }),
        type: trigger.type,
        ...(!isSchedule && trigger.webhookSignatureScheme !== undefined && { webhookSignatureScheme: trigger.webhookSignatureScheme }),
    };

    return JSON.stringify(picked, null, 2);
};

const groupJson = (group: BundleGroup): string =>
    JSON.stringify(
        {
            ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
            mode: group.mode,
            model: group.model,
            participants: group.participants,
            ...(group.synthesizer !== undefined && { synthesizer: group.synthesizer }),
            title: group.title,
        },
        null,
        2,
    );

/** A bundle as the one Markdown file. */
export const buildBundleMarkdown = (bundle: Bundle): string => {
    const description = singleLine(bundle.description, BUNDLE_LIMITS.description);
    const lines = [
        "---",
        `bundle: ${String(BUNDLE_VERSION)}`,
        `name: ${yamlString(singleLine(bundle.name, BUNDLE_LIMITS.name))}`,
        ...(description ? [`description: ${yamlString(description)}`] : []),
        "---",
        "",
        "A bundle of skills, schedules and group chats. It came from whoever sent it: read every item before importing. Nothing in it runs until you turn it on.",
        "",
    ];

    for (const item of bundle.items) {
        if (item.kind === "skill") {
            lines.push(section("skill", item.skill.slug, SKILL_FENCE_INFO, skillToMarkdown(item.skill)));
        } else if (item.kind === "trigger") {
            lines.push(section("trigger", item.trigger.name, JSON_FENCE_INFO, triggerJson(item.trigger)));
        } else {
            lines.push(section("group", item.group.title, JSON_FENCE_INFO, groupJson(item.group)));
        }
    }

    return lines.join("\n");
};

// ─── Reading ─────────────────────────────────────────────────────────────────

interface RawSection {
    content: string;
    index: number;
    kind: BundleItemKind;
    label: string;
}

/** Splits the body into sections, tracking fence state line by line. */
const readSections = (body: string[], errors: string[]): RawSection[] => {
    const sections: RawSection[] = [];
    let current: { fenced: boolean; index: number; kind: BundleItemKind; label: string } | undefined;
    let fence: { content: string[]; ticks: number } | undefined;

    for (const [offset, line] of body.entries()) {
        if (fence) {
            const close = CLOSE_FENCE_RE.exec(line);

            if (close && close[1]!.length >= fence.ticks) {
                sections.push({ content: fence.content.join("\n"), index: current!.index, kind: current!.kind, label: current!.label });
                fence = undefined;
            } else {
                fence.content.push(line);
            }

            continue;
        }

        const heading = HEADING_RE.exec(line);

        if (heading) {
            const kind = KINDS.find((candidate) => candidate === heading[1]);

            if (current && !current.fenced) {
                errors.push(`Item ${String(current.index + 1)} (${current.kind}: ${current.label}) has no code block`);
            }

            if (!kind) {
                errors.push(`Line ${String(offset + 1)} of the bundle body: unknown item kind "${heading[1]!}"`);
                current = undefined;
                continue;
            }

            current = { fenced: false, index: sections.length, kind, label: singleLine(heading[2] ?? "", 100) };
            continue;
        }

        const open = OPEN_FENCE_RE.exec(line);

        if (open) {
            if (!current || current.fenced) {
                errors.push(`Line ${String(offset + 1)} of the bundle body: a code block outside an item`);

                return sections;
            }

            current.fenced = true;
            fence = { content: [], ticks: open[1]!.length };
            continue;
        }

        // Prose before the first item is the file's own introduction; anywhere else it is text the parser would not read.
        if (line.trim() !== "" && current) {
            errors.push(`Line ${String(offset + 1)} of the bundle body: unexpected text in item ${String(current.index + 1)} (${current.label})`);
        }
    }

    if (fence) {
        errors.push(`The code block of item ${String(current!.index + 1)} (${current!.label}) is never closed`);
    } else if (current && !current.fenced) {
        errors.push(`Item ${String(current.index + 1)} (${current.kind}: ${current.label}) has no code block`);
    }

    return sections;
};

const textField = (source: Record<string, unknown>, key: string, max: number, problems: string[], required = false): string | undefined => {
    const value = source[key];

    if (value === undefined || value === null) {
        if (required) {
            problems.push(`"${key}" is required`);
        }

        return undefined;
    }

    if (typeof value !== "string" || (required && value.trim() === "")) {
        problems.push(`"${key}" must be ${required ? "a non-empty " : ""}text`);

        return undefined;
    }

    if (value.length > max) {
        problems.push(`"${key}" is longer than ${String(max)} characters`);

        return undefined;
    }

    return value;
};

const readFilters = (raw: unknown, problems: string[]): BundleFilter[] | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    if (!Array.isArray(raw) || raw.length > MAX_FILTERS) {
        problems.push(`"filters" must be a list of at most ${String(MAX_FILTERS)}`);

        return undefined;
    }

    const filters: BundleFilter[] = [];

    for (const entry of raw) {
        const record = isRecord(entry) ? entry : {};
        const op = FILTER_OPS.find((candidate) => candidate === record.op);

        if (!op || typeof record.path !== "string" || (record.value !== undefined && typeof record.value !== "string")) {
            problems.push(`"filters" holds an entry that is not { op, path, value? }`);

            return undefined;
        }

        filters.push({ op, path: record.path, ...(record.value !== undefined && { value: record.value as string }) });
    }

    return filters;
};

const readTrigger = (raw: unknown, problems: string[]): BundleTrigger | undefined => {
    if (!isRecord(raw)) {
        problems.push("A trigger must be a JSON object");

        return undefined;
    }

    if (raw.type === "event") {
        problems.push("Event triggers are not part of a bundle");

        return undefined;
    }

    if (raw.type !== "schedule" && raw.type !== "webhook") {
        problems.push('"type" must be "schedule" or "webhook"');

        return undefined;
    }

    const { type } = raw;
    const before = problems.length;
    const name = textField(raw, "name", FIELD_CAPS.label, problems, true);
    const model = textField(raw, "model", FIELD_CAPS.model, problems, true);
    const description = textField(raw, "description", FIELD_CAPS.description, problems);
    const inputTemplate = textField(raw, "inputTemplate", FIELD_CAPS.text, problems);
    const systemPrompt = textField(raw, "systemPrompt", FIELD_CAPS.text, problems);
    const searchMode = textField(raw, "searchMode", FIELD_CAPS.short, problems);
    const cronExpression = type === "schedule" ? textField(raw, "cronExpression", FIELD_CAPS.cron, problems, true) : undefined;
    const timezone = type === "schedule" ? textField(raw, "timezone", FIELD_CAPS.timezone, problems) : undefined;
    const filters = type === "webhook" ? readFilters(raw.filters, problems) : undefined;
    const scheme = type === "webhook" ? WEBHOOK_SCHEMES.find((candidate) => candidate === raw.webhookSignatureScheme) : undefined;

    if (type === "webhook" && raw.webhookSignatureScheme !== undefined && !scheme) {
        problems.push('"webhookSignatureScheme" is not a known scheme');
    }

    if (problems.length > before || name === undefined || model === undefined) {
        return undefined;
    }

    return {
        ...(cronExpression !== undefined && { cronExpression }),
        ...(description !== undefined && { description }),
        ...(filters && filters.length > 0 && { filters }),
        ...(inputTemplate !== undefined && { inputTemplate }),
        model,
        name,
        ...(searchMode !== undefined && { searchMode }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(timezone !== undefined && { timezone }),
        type,
        ...(scheme && { webhookSignatureScheme: scheme }),
    };
};

const readGroup = (raw: unknown, problems: string[]): BundleGroup | undefined => {
    if (!isRecord(raw)) {
        problems.push("A group chat must be a JSON object");

        return undefined;
    }

    const before = problems.length;
    const title = textField(raw, "title", FIELD_CAPS.label, problems, true);
    const model = textField(raw, "model", FIELD_CAPS.model, problems, true);
    const synthesizer = textField(raw, "synthesizer", FIELD_CAPS.short, problems);
    const mode = BUNDLE_GROUP_MODES.find((candidate) => candidate === raw.mode);
    const { participants } = raw;

    if (!mode) {
        problems.push('"mode" is not a known group chat mode');
    }

    if (!Array.isArray(participants) || participants.length > 50 || participants.some((slug) => typeof slug !== "string" || slug.length > FIELD_CAPS.short)) {
        problems.push('"participants" must be a list of skill slugs');
    }

    if (raw.debateRounds !== undefined && (typeof raw.debateRounds !== "number" || !Number.isFinite(raw.debateRounds))) {
        problems.push('"debateRounds" must be a number');
    }

    if (problems.length > before || !mode || title === undefined || model === undefined) {
        return undefined;
    }

    return {
        ...(typeof raw.debateRounds === "number" && { debateRounds: raw.debateRounds }),
        mode,
        model,
        participants: participants as string[],
        ...(synthesizer !== undefined && { synthesizer }),
        title,
    };
};

const readEntry = (raw: RawSection, seenSlugs: Set<string>): BundleEntry => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const entry: BundleEntry = { index: raw.index, kind: raw.kind, label: raw.label, problems, warnings };

    if (byteLength(raw.content) > BUNDLE_LIMITS.itemBytes) {
        problems.push(`This item is larger than ${String(BUNDLE_LIMITS.itemBytes / 1024)} KB`);

        return entry;
    }

    if (raw.kind === "skill") {
        const parsed = parseSkillMarkdown(raw.content);

        if (!parsed.ok) {
            problems.push(...parsed.errors);

            return entry;
        }

        if (seenSlugs.has(parsed.skill.slug)) {
            problems.push(`Another skill in this bundle already uses the slug "${parsed.skill.slug}"`);

            return entry;
        }

        seenSlugs.add(parsed.skill.slug);
        warnings.push(...parsed.warnings);

        // An export writes no variable default, so a file that carries one was edited by hand: it is not read.
        const variables = parsed.skill.variables?.map(({ description, name, required }) => {
            return { name, ...(description !== undefined && { description }), ...(required !== undefined && { required }) };
        });

        entry.item = { kind: "skill", skill: { ...parsed.skill, ...(variables && { variables }) } };

        return entry;
    }

    let json: unknown;

    try {
        json = JSON.parse(raw.content);
    } catch {
        problems.push("The item is not valid JSON");

        return entry;
    }

    if (raw.kind === "trigger") {
        const trigger = readTrigger(json, problems);

        if (trigger) {
            entry.item = { kind: "trigger", trigger };
        }
    } else {
        const group = readGroup(json, problems);

        if (group) {
            entry.item = { group, kind: "group" };
        }
    }

    return entry;
};

/** Reads a bundle file. Structural trouble (version, size, counts, fences) fails the file; trouble inside one item stays on that item. */
export const parseBundleMarkdown = (markdown: string): ParseBundleResult => {
    const size = byteLength(markdown);

    if (size > BUNDLE_LIMITS.bytes) {
        return { errors: [`The bundle is larger than ${String(BUNDLE_LIMITS.bytes / 1024)} KB`], ok: false };
    }

    const text = markdown.replaceAll(LINE_BREAK_RE, "\n");
    const match = FRONTMATTER_RE.exec(text);

    if (!match) {
        return { errors: ["This is not a bundle: it must start with a frontmatter block that says `bundle: 1`"], ok: false };
    }

    let frontmatter: ReturnType<typeof parseFrontmatterYaml>;

    try {
        frontmatter = parseFrontmatterYaml(match[1]!);
    } catch (error) {
        return { errors: [error instanceof Error ? error.message : "Unreadable frontmatter"], ok: false };
    }

    const version = frontmatter.bundle;

    if (version === undefined) {
        return { errors: ["This is not a bundle: the frontmatter has no `bundle` version"], ok: false };
    }

    if (version !== String(BUNDLE_VERSION)) {
        return { errors: [`Unsupported bundle version "${String(version)}"; this app reads version ${String(BUNDLE_VERSION)}`], ok: false };
    }

    const errors: string[] = [];
    const sections = readSections(text.slice(match[0].length).split("\n"), errors);
    const counts = { group: 0, skill: 0, trigger: 0 };

    for (const { kind } of sections) {
        counts[kind] += 1;
    }

    for (const [kind, label, limit] of [
        ["skill", "skills", BUNDLE_LIMITS.skills],
        ["trigger", "triggers", BUNDLE_LIMITS.triggers],
        ["group", "group chats", BUNDLE_LIMITS.groupChats],
    ] as const) {
        if (counts[kind] > limit) {
            errors.push(`A bundle holds at most ${String(limit)} ${label} (this one has ${String(counts[kind])})`);
        }
    }

    if (errors.length > 0) {
        return { errors, ok: false };
    }

    const seenSlugs = new Set<string>();
    const name = typeof frontmatter.name === "string" ? singleLine(frontmatter.name, BUNDLE_LIMITS.name) : "";
    const description = typeof frontmatter.description === "string" ? singleLine(frontmatter.description, BUNDLE_LIMITS.description) : "";

    return {
        bundle: { description, entries: sections.map((raw) => readEntry(raw, seenSlugs)), name: name || "Bundle" },
        ok: true,
    };
};

// ─── Export: rows → items, by whitelist ─────────────────────────────────────

export interface SkillSource {
    category?: string;
    config?: {
        additionalTools?: ReadonlyArray<string>;
        disabledTools?: ReadonlyArray<string>;
        preferredModel?: string;
        reasoningEffort?: number;
        searchMode?: string;
    };
    description: string;
    icon?: string;
    instructions: string;
    name: string;
    slug: string;
    tags?: ReadonlyArray<string>;
    variables?: ReadonlyArray<{ description?: string; name: string; required?: boolean }>;
    version?: string;
}

export interface TriggerSource {
    cronExpression?: string;
    description?: string;
    filters?: ReadonlyArray<{ op: (typeof FILTER_OPS)[number]; path: string; value?: string | null }>;
    inputTemplate?: string;
    model: string;
    name: string;
    searchMode?: string;
    systemPrompt?: string;
    timezone?: string;
    type: string;
    webhookSignatureScheme?: string;
}

export interface GroupSource {
    groupChat: {
        debateRounds?: number;
        mode: BundleGroupMode;
        participants: ReadonlyArray<{ skillId: string }>;
        synthesizerSkillId?: string;
    };
    model?: string;
    title?: string;
}

export type ItemResult<T> = { item: T; ok: true } | { ok: false; reason: string };

const compact = <T>(list: ReadonlyArray<T> | undefined): T[] | undefined => (list && list.length > 0 ? [...list] : undefined);

/** A skill as the file carries it: no source, owner, organization, voice, icon URL, variable default, or a tool this app cannot name. */
export const skillItemOf = (
    source: SkillSource,
    options: { isKnownTool: (name: string) => boolean; slug?: string },
): Extract<BundleItem, { kind: "skill" }> => {
    const additionalTools = compact(source.config?.additionalTools?.filter((tool) => options.isKnownTool(tool)));
    const disabledTools = compact(source.config?.disabledTools?.filter((tool) => options.isKnownTool(tool)));
    const preferredModel = source.config?.preferredModel && !isCustomModel(source.config.preferredModel) ? source.config.preferredModel : undefined;
    const config: SkillConfigData = {
        ...(additionalTools && { additionalTools }),
        ...(disabledTools && { disabledTools }),
        ...(preferredModel && { preferredModel }),
        ...(source.config?.reasoningEffort !== undefined && { reasoningEffort: source.config.reasoningEffort }),
        ...(source.config?.searchMode && { searchMode: source.config.searchMode }),
    };
    const variables: SkillVariableData[] | undefined = compact(
        source.variables?.map((variable) => {
            return {
                name: variable.name,
                ...(variable.description !== undefined && { description: variable.description }),
                ...(variable.required !== undefined && { required: variable.required }),
            };
        }),
    );
    const icon = source.icon && source.icon.length <= 64 && !NON_ICON_RE.test(source.icon) ? source.icon : undefined;
    const tags = compact(source.tags);

    return {
        kind: "skill",
        skill: {
            ...(source.category && { category: source.category }),
            ...(Object.keys(config).length > 0 && { config }),
            description: source.description,
            ...(icon && { icon }),
            instructions: source.instructions,
            name: source.name,
            slug: options.slug ?? source.slug,
            ...(tags && { tags }),
            ...(variables && { variables }),
            ...(source.version && { version: source.version }),
        },
    };
};

/** A schedule or webhook trigger without its secret, URL, bot, organization or enabled state. */
export const triggerItemOf = (source: TriggerSource): ItemResult<Extract<BundleItem, { kind: "trigger" }>> => {
    if (source.type !== "schedule" && source.type !== "webhook") {
        return { ok: false, reason: "Only schedules and webhooks can be shared." };
    }

    if (isCustomModel(source.model)) {
        return { ok: false, reason: "It runs on a custom endpoint of yours, which another account does not have." };
    }

    const isSchedule = source.type === "schedule";
    const scheme = WEBHOOK_SCHEMES.find((candidate) => candidate === source.webhookSignatureScheme);
    const filters = isSchedule
        ? undefined
        : compact(
              source.filters?.map((filter) => {
                  return { op: filter.op, path: filter.path, ...(typeof filter.value === "string" && { value: filter.value }) };
              }),
          );

    return {
        item: {
            kind: "trigger",
            trigger: {
                ...(isSchedule && source.cronExpression !== undefined && { cronExpression: source.cronExpression }),
                ...(source.description && { description: source.description }),
                ...(filters && { filters }),
                ...(source.inputTemplate && { inputTemplate: source.inputTemplate }),
                model: source.model,
                name: source.name,
                ...(source.searchMode && { searchMode: source.searchMode }),
                ...(source.systemPrompt && { systemPrompt: source.systemPrompt }),
                ...(isSchedule && source.timezone && { timezone: source.timezone }),
                type: source.type,
                ...(!isSchedule && scheme && { webhookSignatureScheme: scheme }),
            },
        },
        ok: true,
    };
};

/** A group chat setup, its participants named by `slugOf` (a skill id → the slug it has in the bundle). */
export const groupItemOf = (source: GroupSource, slugOf: (skillId: string) => string | undefined): ItemResult<Extract<BundleItem, { kind: "group" }>> => {
    if (!source.model) {
        return { ok: false, reason: "It has no model." };
    }

    if (isCustomModel(source.model)) {
        return { ok: false, reason: "It runs on a custom endpoint of yours, which another account does not have." };
    }

    const participants = source.groupChat.participants.map((participant) => slugOf(participant.skillId));
    const synthesizer = source.groupChat.synthesizerSkillId === undefined ? undefined : slugOf(source.groupChat.synthesizerSkillId);

    if (participants.includes(undefined) || (source.groupChat.synthesizerSkillId !== undefined && synthesizer === undefined)) {
        return { ok: false, reason: "One of its participants is no longer available to you." };
    }

    return {
        item: {
            group: {
                ...(source.groupChat.debateRounds !== undefined && { debateRounds: source.groupChat.debateRounds }),
                mode: source.groupChat.mode,
                model: source.model,
                participants: participants as string[],
                ...(synthesizer !== undefined && { synthesizer }),
                title: source.title?.trim() || "Group chat",
            },
            kind: "group",
        },
        ok: true,
    };
};
