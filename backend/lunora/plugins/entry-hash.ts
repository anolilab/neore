/**
 * The content hash of one plugin entry. Install stores it on the child's link, and update compares it with the child's
 * live hash, so the two must be computed from the same fields. A skill's content is its content fields only (the owner,
 * flags and ids on its row are not content), so the file's entry and the row are read through the same field list.
 */
import { DEFAULT_GROUP_TITLE } from "../chat/group/functions";
import type { PlanEntry } from "../skills/bundle-plan";
import { contentHash } from "./logic";

/** The fields of a skill that the file defines. */
export interface SkillContent {
    category?: string;
    config?: unknown;
    description: string;
    icon?: string;
    instructions: string;
    name: string;
    slug: string;
    tags?: string[];
    variables?: unknown;
    version?: string;
}

/** A skill's content, with only the fields the file defines. */
export const skillContent = (source: SkillContent): SkillContent => ({
    category: source.category,
    config: source.config,
    description: source.description,
    icon: source.icon,
    instructions: source.instructions,
    name: source.name,
    slug: source.slug,
    tags: source.tags,
    variables: source.variables,
    version: source.version,
});

/** The fields of a trigger that the file defines and its row stores as written. */
export interface TriggerContent {
    botComputer?: boolean;
    botId?: string;
    cronExpression?: string;
    description?: string;
    eventSource?: unknown;
    filters?: unknown;
    inputTemplate?: string;
    model?: string;
    name: string;
    quietWhenEmpty?: boolean;
    searchMode?: string;
    systemPrompt?: string;
    timezone?: string;
    type: string;
    webhookSignatureScheme?: string;
}

/** A trigger's content, with only the fields the file defines. */
export const triggerContent = (source: TriggerContent): TriggerContent => ({
    botComputer: source.botComputer,
    botId: source.botId,
    cronExpression: source.cronExpression,
    description: source.description,
    eventSource: source.eventSource,
    filters: source.filters,
    inputTemplate: source.inputTemplate,
    model: source.model,
    name: source.name,
    quietWhenEmpty: source.quietWhenEmpty,
    searchMode: source.searchMode,
    systemPrompt: source.systemPrompt,
    timezone: source.timezone,
    type: source.type,
    webhookSignatureScheme: source.webhookSignatureScheme,
});

/** A trigger's live hash, read back from its row. A row that stores a field differently from the file reads as edited, which is the safe side. */
export const triggerRowHash = async (row: TriggerContent): Promise<string> => await contentHash(triggerContent(row));

/** The hash of an entry as the file defines it. A skill and a trigger are hashed over their content fields, the way their rows are. */
export const entryHash = async (entry: PlanEntry): Promise<string> => {
    if (entry.plan?.kind === "skill") {
        return await contentHash(skillContent(entry.plan.create));
    }

    if (entry.plan?.kind === "trigger") {
        return await contentHash(triggerContent(entry.plan.create as TriggerContent));
    }

    if (entry.plan?.kind === "group") {
        return await contentHash(groupContent(entry.plan.create));
    }

    // An entry the planner could not plan has no content, so it hashes as nothing.
    return await contentHash(null);
};

/** A skill's live hash, read back from its row. */
export const skillRowHash = async (row: SkillContent): Promise<string> => await contentHash(skillContent(row));

/** A group's title as stored: trimmed, at most 200 characters, and the default when it is empty. */
export const normalizeGroupTitle = (title: string | undefined): string => title?.trim().slice(0, 200) || DEFAULT_GROUP_TITLE;

/** The fields of a group the file defines. Participants are named by their entry keys, as the file names them. */
export interface GroupContent {
    debateRounds?: number;
    mode: string;
    model: string;
    participantKeys: string[];
    synthesizerKey?: string;
    title: string;
}

/** A group's content as the file defines it. */
export const groupContent = (source: {
    debateRounds?: number;
    mode: string;
    model: string;
    participantKeys: string[];
    synthesizerKey?: string;
    title: string;
}): GroupContent => ({
    debateRounds: source.debateRounds,
    mode: source.mode,
    model: source.model,
    participantKeys: [...source.participantKeys],
    synthesizerKey: source.synthesizerKey,
    title: normalizeGroupTitle(source.title),
});

/**
 * A group's live hash, read back from its thread. Each stored participant is mapped to its plugin entry key. A participant that
 * is not a plugin skill maps to an "unmapped" key, so a swapped-in skill reads as an edit.
 */
export const groupRowHash = async (
    row: {
        debateRounds?: number;
        mode: string;
        model: string;
        participants: Array<{ skillId: string }>;
        synthesizerSkillId?: string;
        title?: string;
    },
    keyOf: (skillId: string) => string | undefined,
): Promise<string> => {
    const mapped = (skillId: string): string => keyOf(skillId) ?? `unmapped:${skillId}`;

    return await contentHash(
        groupContent({
            debateRounds: row.debateRounds,
            mode: row.mode,
            model: row.model,
            participantKeys: row.participants.map((participant) => mapped(participant.skillId)),
            synthesizerKey: row.synthesizerSkillId === undefined ? undefined : mapped(row.synthesizerSkillId),
            title: row.title ?? "",
        }),
    );
};
