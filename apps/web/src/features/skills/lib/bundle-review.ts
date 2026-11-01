/**
 * The selection rules of the bundle dialogs, kept out of the components. The
 * server decides what is importable (`previewBundle` marks an item `problems`,
 * `importBundle` re-checks everything); this only keeps the picks consistent
 * so the review screen never offers a combination the server would refuse.
 */
import { findFreeSlug, slugRenamedWarning } from "@neore/backend/skills/slug-pick";

/** One item of the review screen, as `previewBundle` returns it. */
export interface BundleReviewEntry {
    group?: { debateRounds?: number; mode: string; model: string; participants: string[]; synthesizer?: string };
    key: string;
    kind: "group" | "skill" | "trigger";
    problems: string[];
    /** Keys of the skills a group chat needs in the same selection. */
    requires: string[];
    skill?: {
        /** The slug the file names; `slug` is what the server picked with every skill reserved. */
        baseSlug: string;
        description: string;
        disabledTools: string[];
        droppedTools: string[];
        /** The whole text the skill runs on. */
        instructions: string;
        model?: string;
        name: string;
        reasoningEffort?: number;
        searchMode?: string;
        slug: string;
        tools: string[];
    };
    title: string;
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
    warnings: string[];
}

/** Everything that can be imported is picked at first: the user unticks what they do not want. */
export const defaultSelection = (entries: ReadonlyArray<BundleReviewEntry>): Set<string> =>
    new Set(entries.filter((entry) => entry.problems.length === 0).map((entry) => entry.key));

/**
 * Ticks or unticks one item. Ticking a group chat ticks the skills it needs;
 * unticking a skill unticks the group chats that need it.
 */
export const toggleSelection = (selected: ReadonlySet<string>, key: string, entries: ReadonlyArray<BundleReviewEntry>): Set<string> => {
    const next = new Set(selected);
    const entry = entries.find((candidate) => candidate.key === key);

    if (!entry || entry.problems.length > 0) {
        return next;
    }

    if (next.has(key)) {
        next.delete(key);

        for (const other of entries) {
            if (other.requires.includes(key)) {
                next.delete(other.key);
            }
        }

        return next;
    }

    next.add(key);

    for (const required of entry.requires) {
        next.add(required);
    }

    return next;
};

const entryIndex = (entry: BundleReviewEntry): number => Number(entry.key.split(":", 2)[1]);

/**
 * The review with each skill's slug the way the import will pick it for THIS selection (the server's preview reserves
 * every skill's slug, so an unticked skill would otherwise push a later one to a slug the import does not use). Mirrors
 * `planBundle`: in file order, only a selected skill the server found importable takes its slug.
 */
export const withSelectionSlugs = (
    entries: ReadonlyArray<BundleReviewEntry>,
    selected: ReadonlySet<string>,
    existingSlugs: ReadonlyArray<string>,
): BundleReviewEntry[] => {
    const taken = new Set(existingSlugs);
    const slugs = new Map<string, string>();

    const skillEntries = entries.filter((candidate) => candidate.skill).toSorted((a, b) => entryIndex(a) - entryIndex(b));

    for (const entry of skillEntries) {
        const { baseSlug } = entry.skill!;
        const slug = findFreeSlug(baseSlug, taken) ?? entry.skill!.slug;

        slugs.set(entry.key, slug);

        if (entry.problems.length === 0 && selected.has(entry.key)) {
            taken.add(slug);
        }
    }

    return entries.map((entry) => {
        const slug = slugs.get(entry.key);

        if (!entry.skill || slug === undefined) {
            return entry;
        }

        const stale = slugRenamedWarning(entry.skill.baseSlug, entry.skill.slug);

        return {
            ...entry,
            skill: { ...entry.skill, slug },
            warnings: [
                ...entry.warnings.filter((warning) => warning !== stale),
                ...(slug === entry.skill.baseSlug ? [] : [slugRenamedWarning(entry.skill.baseSlug, slug)]),
            ],
        };
    });
};

export const selectedCount = (selected: ReadonlySet<string>, entries: ReadonlyArray<BundleReviewEntry>, kind?: BundleReviewEntry["kind"]): number =>
    entries.filter((entry) => selected.has(entry.key) && (kind === undefined || entry.kind === kind)).length;

/** Whether the picked skills fit the free-account limit (`null` = no limit). */
export const fitsSkillSlots = (selected: ReadonlySet<string>, entries: ReadonlyArray<BundleReviewEntry>, slotsLeft: number | null): boolean =>
    slotsLeft === null || selectedCount(selected, entries, "skill") <= slotsLeft;

/** The skills an export contains: the picked ones plus the participants of the picked group chats. */
export const exportedSkillIds = (
    pickedSkills: ReadonlySet<string>,
    pickedGroups: ReadonlySet<string>,
    groups: ReadonlyArray<{ id: string; participantSkillIds: string[] }>,
): Set<string> => {
    const ids = new Set(pickedSkills);

    for (const group of groups) {
        if (pickedGroups.has(group.id)) {
            for (const skillId of group.participantSkillIds) {
                ids.add(skillId);
            }
        }
    }

    return ids;
};
