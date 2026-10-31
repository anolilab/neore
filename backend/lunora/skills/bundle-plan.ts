/**
 * What importing a bundle would do — a full dry run — and the all-or-nothing
 * import itself. Pure: the caller supplies what the database knows (taken
 * slugs, the skill count, the tool and model catalogues) and the operations
 * that create and delete, so both halves are unit-tested without a runtime.
 *
 * The preview and the import run the SAME `planBundle` on the file the client
 * sends. The plan is never trusted back from the client: an import re-parses,
 * re-plans against the user's current state and the selection, and refuses if
 * anything it was asked to create is blocked.
 */
import { LunoraError } from "lunorash/server";

import { normalizeGroupOptions, validateParticipantIds } from "../chat/group/logic";
import { resolveTimeZone } from "../memory/reflection-logic";
import { assertValidFilters } from "../triggers/filters";
import { findNextCronTime, isHourlyOrSlowerCronExpression } from "../triggers/schedule";
import type { BundleFilter, BundleGroup, BundleItemKind, BundleTrigger, ParsedBundle } from "./bundle-format";
import type { SkillMarkdownData } from "./markdown";
import { planSkillImport } from "./import-plan";
import { FREE_SKILL_LIMIT } from "./constants";
import { MAX_LENGTH } from "../lib/validators";
import { pickFreeSlug } from "./slug";

export interface PlanEnv {
    existingSkillCount: number;
    /** Slugs the user's skills already use. */
    existingSlugs: ReadonlySet<string>;
    isKnownTool: (name: string) => boolean;
    /** An enabled platform text model — never a user's own `custom:` endpoint. */
    isModelRunnable: (model: string) => boolean;
    now: number;
    /** `undefined` for an account without a skill limit. */
    skillLimit: number | undefined;
}

export const skillLimitFor = (user: { isAdmin?: boolean; plan?: string | null }): number | undefined =>
    user.plan === "premium" || user.isAdmin === true ? undefined : FREE_SKILL_LIMIT;

export interface SkillCreate {
    category?: string;
    config?: SkillMarkdownData["config"];
    description: string;
    icon?: string;
    instructions: string;
    name: string;
    slug: string;
    tags?: string[];
    variables?: SkillMarkdownData["variables"];
    version?: string;
}

export interface TriggerCreate {
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
    webhookSignatureScheme?: BundleTrigger["webhookSignatureScheme"];
}

export interface GroupCreate {
    debateRounds?: number;
    mode: BundleGroup["mode"];
    model: string;
    /** Keys of the skill entries, resolved to the new skill ids at import. */
    participantKeys: string[];
    synthesizerKey?: string;
    title: string;
}

export type PlannedCreate = { create: GroupCreate; kind: "group" } | { create: SkillCreate; kind: "skill" } | { create: TriggerCreate; kind: "trigger" };

/** What the review screen shows for one item. */
export interface PlanEntry {
    /** `<kind>:<index>`: how the client names an item in its selection. */
    key: string;
    kind: BundleItemKind;
    plan?: PlannedCreate;
    problems: string[];
    /** Keys of the skills a group chat needs in the same selection. */
    requires: string[];
    title: string;
    view: PlanView;
    warnings: string[];
}

export interface PlanView {
    group?: { debateRounds?: number; mode: string; model: string; participants: string[]; synthesizer?: string };
    skill?: {
        description: string;
        disabledTools: string[];
        droppedTools: string[];
        /** The whole text the skill would run on: what the user is asked to approve. */
        instructions: string;
        model?: string;
        name: string;
        slug: string;
        tools: string[];
    };
    trigger?: {
        description?: string;
        filters: string[];
        model: string;
        nextRunAt?: number;
        schedule?: string;
        systemPrompt?: string;
        task?: string;
        timezone?: string;
        type: "schedule" | "webhook";
    };
}

export const entryKey = (kind: BundleItemKind, index: number): string => `${kind}:${String(index)}`;

/** A longer value is blocked here, not at import: `createSkill` caps these at `MAX_LENGTH.short` / `MAX_LENGTH.long`. */
const skillCapProblems = (skill: SkillMarkdownData): string[] => {
    const problems: string[] = [];
    const tooLong = (value: string | undefined, max: number): boolean => value !== undefined && value.length > max;

    if (tooLong(skill.category, MAX_LENGTH.short) || tooLong(skill.version, MAX_LENGTH.short) || skill.tags?.some((tag) => tooLong(tag, MAX_LENGTH.short))) {
        problems.push(`The category, version and every tag must be ${String(MAX_LENGTH.short)} characters or less.`);
    }

    if (skill.variables?.some((variable) => tooLong(variable.description, MAX_LENGTH.long))) {
        problems.push(`A variable's description must be ${String(MAX_LENGTH.long)} characters or less.`);
    }

    return problems;
};

const describeFilter = (filter: BundleFilter): string =>
    `${filter.path} ${filter.op.replaceAll("_", " ")}${filter.value === undefined ? "" : ` "${filter.value}"`}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Not valid");

const planTrigger = (trigger: BundleTrigger, env: PlanEnv, problems: string[]): { create?: TriggerCreate; view: NonNullable<PlanView["trigger"]> } => {
    const view: NonNullable<PlanView["trigger"]> = {
        ...(trigger.description !== undefined && { description: trigger.description }),
        filters: (trigger.filters ?? []).map((filter) => describeFilter(filter)),
        model: trigger.model,
        ...(trigger.systemPrompt !== undefined && { systemPrompt: trigger.systemPrompt }),
        ...(trigger.inputTemplate !== undefined && { task: trigger.inputTemplate }),
        type: trigger.type,
    };

    if (!env.isModelRunnable(trigger.model)) {
        problems.push(`The model "${trigger.model}" is not available here.`);
    }

    if (trigger.type === "schedule") {
        const cron = trigger.cronExpression ?? "";
        const timezone = trigger.timezone?.trim() || undefined;

        view.schedule = cron;

        if (timezone) {
            view.timezone = timezone;
        }

        if (timezone !== undefined && resolveTimeZone(timezone) !== timezone) {
            problems.push(`Unknown time zone "${timezone}".`);
        }

        if (isHourlyOrSlowerCronExpression(cron)) {
            const next = findNextCronTime(cron, env.now, timezone);

            if (next === undefined) {
                problems.push(`"${cron}" never fires, so the schedule could not be turned on.`);
            } else {
                view.nextRunAt = next;
            }
        } else {
            problems.push(`"${cron}" is not a 5-field cron expression that runs at most hourly.`);
        }
    } else if (trigger.filters && trigger.filters.length > 0) {
        try {
            assertValidFilters(trigger.filters);
        } catch (error) {
            problems.push(messageOf(error));
        }
    }

    if (problems.length > 0) {
        return { view };
    }

    return {
        create: {
            ...(trigger.cronExpression !== undefined && trigger.type === "schedule" && { cronExpression: trigger.cronExpression }),
            ...(trigger.description !== undefined && { description: trigger.description }),
            ...(trigger.filters && trigger.type === "webhook" && { filters: trigger.filters }),
            ...(trigger.inputTemplate !== undefined && { inputTemplate: trigger.inputTemplate }),
            model: trigger.model,
            name: trigger.name,
            ...(trigger.searchMode !== undefined && { searchMode: trigger.searchMode }),
            ...(trigger.systemPrompt !== undefined && { systemPrompt: trigger.systemPrompt }),
            ...(trigger.type === "schedule" && trigger.timezone?.trim() && { timezone: trigger.timezone.trim() }),
            type: trigger.type,
            ...(trigger.type === "webhook" && trigger.webhookSignatureScheme && { webhookSignatureScheme: trigger.webhookSignatureScheme }),
        },
        view,
    };
};

/**
 * Dry-runs the whole file. `selected` is the set of entry keys the user picked
 * (`undefined` = all, for the review screen): only selected skills take a slug
 * or count against the skill limit, and a group chat is ready only when every
 * participant is a selected, importable skill.
 */
export const planBundle = (bundle: ParsedBundle, selected: ReadonlySet<string> | undefined, env: PlanEnv): PlanEntry[] => {
    const isSelected = (key: string): boolean => selected === undefined || selected.has(key);
    const taken = new Set(env.existingSlugs);
    const slotsLeft = env.skillLimit === undefined ? Infinity : Math.max(0, env.skillLimit - env.existingSkillCount);
    let slotsUsed = 0;
    const entries: PlanEntry[] = [];
    // The source slug of each skill the file holds → its entry key, for group participants.
    const skillKeyBySlug = new Map<string, string>();

    for (const entry of bundle.entries) {
        if (entry.item?.kind === "skill") {
            skillKeyBySlug.set(entry.item.skill.slug, entryKey("skill", entry.index));
        }
    }

    // Skills first: groups look their participants up in the finished entries.
    for (const entry of bundle.entries) {
        if (entry.kind !== "skill") {
            continue;
        }

        const key = entryKey(entry.kind, entry.index);
        const problems = [...entry.problems];
        const warnings = [...entry.warnings];

        const view: PlanView = {};
        let plan: PlannedCreate | undefined;
        let title = entry.label;

        if (entry.item?.kind === "skill") {
            const planned = planSkillImport(entry.item.skill, env.isKnownTool);

            title = entry.item.skill.name;
            warnings.push(...planned.warnings);
            problems.push(...skillCapProblems(entry.item.skill));

            // The quota is a property of a chosen set: the review screen (nothing chosen yet) lets the user pick within it.
            if (selected !== undefined && isSelected(key)) {
                if (slotsUsed >= slotsLeft) {
                    problems.push(`Free accounts are limited to ${String(env.skillLimit)} skills. Upgrade to import more.`);
                } else {
                    slotsUsed += 1;
                }
            }

            let { slug } = planned;

            try {
                slug = pickFreeSlug(planned.slug, taken);
            } catch (error) {
                problems.push(messageOf(error));
            }

            if (problems.length === 0 && isSelected(key)) {
                taken.add(slug);
            }

            if (slug !== planned.slug) {
                warnings.push(`You already have a skill named "${planned.slug}"; this one will be imported as "${slug}".`);
            }

            view.skill = {
                description: planned.description,
                disabledTools: planned.config?.disabledTools ?? [],
                droppedTools: planned.droppedTools,
                instructions: planned.instructions,
                ...(planned.config?.preferredModel && { model: planned.config.preferredModel }),
                name: planned.name,
                slug,
                tools: planned.config?.additionalTools ?? [],
            };

            if (problems.length === 0) {
                plan = {
                    create: {
                        ...(planned.category && { category: planned.category }),
                        ...(planned.config && { config: planned.config }),
                        description: planned.description,
                        ...(planned.icon && { icon: planned.icon }),
                        instructions: planned.instructions,
                        name: planned.name,
                        slug,
                        ...(planned.tags && { tags: planned.tags }),
                        ...(planned.variables && { variables: planned.variables }),
                        ...(planned.version && { version: planned.version }),
                    },
                    kind: "skill",
                };
            }
        }

        entries.push({ key, kind: "skill", ...(plan && { plan }), problems, requires: [], title, view, warnings });
    }

    const skillEntry = (key: string): PlanEntry | undefined => entries.find((candidate) => candidate.key === key);

    for (const entry of bundle.entries) {
        if (entry.kind === "skill") {
            continue;
        }

        const key = entryKey(entry.kind, entry.index);
        const problems = [...entry.problems];
        const warnings = [...entry.warnings];
        const base = { key, kind: entry.kind, requires: [] as string[], warnings };

        if (entry.item?.kind === "trigger") {
            const { create, view } = planTrigger(entry.item.trigger, env, problems);

            entries.push({
                ...base,
                ...(create && problems.length === 0 && { plan: { create, kind: "trigger" as const } }),
                problems,
                title: entry.item.trigger.name,
                view: { trigger: view },
            });
            continue;
        }

        if (entry.item?.kind === "group") {
            const { group } = entry.item;
            const requires: string[] = [];
            const names: string[] = [];

            if (!env.isModelRunnable(group.model)) {
                problems.push(`The model "${group.model}" is not available here.`);
            }

            if (group.participants.length < 2) {
                problems.push("A group chat needs at least two participants.");
            }

            const participantError = validateParticipantIds(group.participants, () => true);

            if (participantError) {
                problems.push(participantError);
            }

            const optionsError = normalizeGroupOptions({
                ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                mode: group.mode,
                skillIds: group.participants,
                ...(group.synthesizer !== undefined && { synthesizerSkillId: group.synthesizer }),
            });

            if ("error" in optionsError) {
                problems.push(optionsError.error);
            }

            const distinct = [...new Set(group.participants)];

            for (const slug of distinct) {
                const skillKey = skillKeyBySlug.get(slug);
                const skill = skillKey === undefined ? undefined : skillEntry(skillKey);

                names.push(slug);

                if (!skillKey || !skill) {
                    problems.push(`Its participant "${slug}" is not a skill in this bundle.`);
                } else if (skill.problems.length > 0) {
                    problems.push(`Its participant "${slug}" cannot be imported: ${skill.problems.join(" ")}`);
                } else if (isSelected(skillKey)) {
                    requires.push(skillKey);
                } else {
                    problems.push(`Its participant "${slug}" is not selected. Select it too, or leave this group chat out.`);
                }
            }

            const view: PlanView = {
                group: {
                    ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                    mode: group.mode,
                    model: group.model,
                    participants: names,
                    ...(group.synthesizer !== undefined && { synthesizer: group.synthesizer }),
                },
            };
            const synthesizerKey = group.synthesizer === undefined ? undefined : skillKeyBySlug.get(group.synthesizer);

            entries.push({
                ...base,
                ...(problems.length === 0 && {
                    plan: {
                        create: {
                            ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                            mode: group.mode,
                            model: group.model,
                            participantKeys: group.participants.map((slug) => skillKeyBySlug.get(slug)!),
                            ...(synthesizerKey !== undefined && { synthesizerKey }),
                            title: group.title,
                        },
                        kind: "group" as const,
                    },
                }),
                problems,
                requires,
                title: group.title,
                view,
            });
            continue;
        }

        entries.push({ ...base, problems: problems.length > 0 ? problems : ["This item could not be read."], title: entry.label, view: {} });
    }

    return entries.toSorted((a, b) => Number(a.key.split(":", 2)[1]) - Number(b.key.split(":", 2)[1]));
};

// ─── The import ─────────────────────────────────────────────────────────────

/** The creates and deletes an import is made of; the procedure wires them to `createSkill`, `createImportedGroupChat`, `createTrigger` and the unlimited, owner-only `removeImportedItem`. */
export interface BundleOps {
    createGroupChat: (args: Omit<GroupCreate, "participantKeys" | "synthesizerKey"> & { skillIds: string[]; synthesizerSkillId?: string }) => Promise<string>;
    createSkill: (args: SkillCreate) => Promise<string>;
    createTrigger: (args: TriggerCreate) => Promise<{ triggerId: string; webhookSecret?: string }>;
    deleteGroupChat: (threadId: string) => Promise<unknown>;
    deleteSkill: (skillId: string) => Promise<unknown>;
    deleteTrigger: (triggerId: string) => Promise<unknown>;
}

export interface ImportedItem {
    id: string;
    key: string;
    kind: BundleItemKind;
    title: string;
    /** Shown to the user once: the signing secret of a new webhook. */
    webhookSecret?: string;
}

export class BundleImportError extends Error {
    /** What could not be removed again after the failure. */
    leftBehind: string[];

    constructor(message: string, leftBehind: string[]) {
        super(message);
        this.name = "BundleImportError";
        this.leftBehind = leftBehind;
    }
}

const removeCreated = async (item: ImportedItem, ops: BundleOps): Promise<unknown> => {
    if (item.kind === "skill") {
        return await ops.deleteSkill(item.id);
    }

    return item.kind === "group" ? await ops.deleteGroupChat(item.id) : await ops.deleteTrigger(item.id);
};

const createdId = (idByKey: ReadonlyMap<string, string>, key: string): string => {
    const id = idByKey.get(key);

    if (id === undefined) {
        throw new Error(`${key} was not created before the item that needs it`);
    }

    return id;
};

/** Creates one planned entry; a group chat finds its participants among the skills created before it. */
const createPlanned = async (entry: PlanEntry, ops: BundleOps, idByKey: Map<string, string>): Promise<ImportedItem> => {
    const { plan } = entry;

    if (plan?.kind === "skill") {
        const id = await ops.createSkill(plan.create);

        idByKey.set(entry.key, id);

        return { id, key: entry.key, kind: "skill", title: entry.title };
    }

    if (plan?.kind === "group") {
        const { participantKeys, synthesizerKey, ...rest } = plan.create;
        const synthesizerSkillId = synthesizerKey === undefined ? undefined : idByKey.get(synthesizerKey);
        const id = await ops.createGroupChat({
            ...rest,
            skillIds: participantKeys.map((key) => createdId(idByKey, key)),
            ...(synthesizerSkillId !== undefined && { synthesizerSkillId }),
        });

        return { id, key: entry.key, kind: "group", title: entry.title };
    }

    if (plan?.kind === "trigger") {
        const { triggerId, webhookSecret } = await ops.createTrigger(plan.create);

        return { id: triggerId, key: entry.key, kind: "trigger", title: entry.title, ...(webhookSecret !== undefined && { webhookSecret }) };
    }

    throw new Error("Nothing to import");
};

/**
 * Creates the selected entries (already checked ready by `assertSelectionImportable`) — skills, then the group chats that
 * need them, then triggers — and removes everything created so far when one
 * of them fails. Removal is best effort (each create is its own mutation): an
 * item it cannot remove is named in the error; a skill and a trigger stay switched off, a group chat starts nothing.
 */
export const runBundleImport = async (entries: ReadonlyArray<PlanEntry>, selected: ReadonlySet<string>, ops: BundleOps): Promise<ImportedItem[]> => {
    const created: ImportedItem[] = [];
    const idByKey = new Map<string, string>();
    const order: Record<BundleItemKind, number> = { group: 1, skill: 0, trigger: 2 };
    const todo = entries
        .filter((entry) => entry.plan && selected.has(entry.key))
        .toSorted((a, b) => order[a.kind] - order[b.kind] || Number(a.key.split(":", 2)[1]) - Number(b.key.split(":", 2)[1]));

    const rollback = async (): Promise<string[]> => {
        const failed: string[] = [];
        let groupLeft = false;

        for (const item of created.toReversed()) {
            // A group chat that is still there names the skills created before it: they stay, or it would point at nothing.
            if (item.kind === "skill" && groupLeft) {
                failed.push(item.title);
                continue;
            }

            try {
                await removeCreated(item, ops);
            } catch {
                failed.push(item.title);
                groupLeft ||= item.kind === "group";
            }
        }

        return failed;
    };

    for (const entry of todo) {
        try {
            created.push(await createPlanned(entry, ops, idByKey));
        } catch (error) {
            const leftBehind = await rollback();
            const reason = messageOf(error);

            throw new BundleImportError(
                leftBehind.length === 0
                    ? `"${entry.title}" could not be imported (${reason}). Nothing was imported.`
                    : `"${entry.title}" could not be imported (${reason}), and these could not be removed again: ${leftBehind.join(", ")}. They were created switched off; delete them by hand.`,
                leftBehind,
            );
        }
    }

    return created;
};

/** Throws the first blocked entry among the selection, naming each. */
export const assertSelectionImportable = (entries: ReadonlyArray<PlanEntry>, selected: ReadonlySet<string>): void => {
    const unknown = [...selected].filter((key) => entries.every((entry) => entry.key !== key));

    if (unknown.length > 0) {
        throw new LunoraError("BAD_REQUEST", "The selection names items that are not in this bundle.");
    }

    const blocked = entries.filter((entry) => selected.has(entry.key) && entry.problems.length > 0);

    if (blocked.length > 0) {
        throw new LunoraError("BAD_REQUEST", blocked.map((entry) => `${entry.title}: ${entry.problems.join(" ")}`).join(" | "));
    }

    if (selected.size === 0) {
        throw new LunoraError("BAD_REQUEST", "Select at least one item to import.");
    }
};
