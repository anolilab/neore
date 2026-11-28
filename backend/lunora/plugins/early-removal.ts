/**
 * Skills an update removes before it creates anything. An update that swaps one skill for another would otherwise run into the
 * free skill limit, and the new skill would take a "-2" slug, because the dropped skill is still there while the new one is made.
 *
 * A sure-to-go skill is removed early only when a create needs its place: a new skill would otherwise get a suffixed slug because the
 * dropped skill holds the slug, or the account is at its skill limit. Every other dropped skill waits for the normal removal after the
 * creates, so a failed create loses nothing.
 *
 * Only a skill that is SURE to go is removed early: created, no step in flight on it, unedited, private, and named by none of the
 * owner's group chats according to a complete participant index (`chat/group/skill-index.ts`). Without a complete index nothing is
 * sure, and the update keeps its order (create, then remove). `previewUpdate`, `updatePlugin` and the slug planning all take the
 * freed slugs from {@link planWithNeededRemovals}, so the three plan the same slugs; the slug is part of the skill's hash.
 */
import { entryKey } from "../skills/bundle-plan";
import type { PlanEntry } from "../skills/bundle-plan";
import { parseBundleMarkdown } from "../skills/bundle-format";

export interface SureSkill {
    entryKey: string;
    slug: string;
}

/** The entry keys a plugin file holds, read from its structure (no slug or limit planning). */
export const fileEntryKeys = (markdown: string): Set<string> => {
    const parsed = parseBundleMarkdown(markdown);

    return new Set(parsed.ok ? parsed.bundle.entries.map((entry) => entryKey(entry.kind, entry.index, entry.declaredKey)) : []);
};

/** The sure-to-go skills the new file drops. */
export const freedSkills = (sure: ReadonlyArray<SureSkill>, fileKeys: ReadonlySet<string>): SureSkill[] =>
    sure.filter((skill) => !fileKeys.has(skill.entryKey));

interface Planned {
    entries: PlanEntry[];
    env: { existingSkillCount: number; skillLimit?: number };
}

/**
 * The plan for the file, with exactly the slugs of the skills an update must remove before it creates. `planWith` plans the file
 * with the given slugs freed. `previewUpdate` and `updatePlugin` both plan through here, so they see the same slugs.
 */
export const planWithNeededRemovals = async (
    sure: ReadonlyArray<SureSkill>,
    fileKeys: ReadonlySet<string>,
    children: ReadonlyArray<{ entryKey: string; kind: string }>,
    planWith: (freedSlugs: string[]) => Promise<Planned>,
): Promise<{ entries: PlanEntry[]; freed: SureSkill[] }> => {
    const candidates = freedSkills(sure, fileKeys);
    const base = await planWith([]);

    if (candidates.length === 0) {
        return { entries: base.entries, freed: [] };
    }

    const all = await planWith(candidates.map((skill) => skill.slug));
    const childKind = new Map(children.map((child) => [child.entryKey, child.kind] as const));
    const creates = all.entries.filter((entry) => entry.kind === "skill" && entry.plan !== undefined && childKind.get(entry.key) !== "skill");
    const needed = new Set<SureSkill>();

    // (a) A new skill that would get a "-2" slug because a dropped skill holds the one it wants.
    for (const entry of creates) {
        const wanted = entry.view.skill?.baseSlug;
        const planned = base.entries.find((candidate) => candidate.key === entry.key)?.view.skill?.slug;
        const holder = candidates.find((skill) => skill.slug === wanted);

        if (holder !== undefined && planned !== wanted) {
            needed.add(holder);
        }
    }

    // (b) The account is at its skill limit and the creates need the places.
    if (base.env.skillLimit !== undefined) {
        const deficit = base.env.existingSkillCount + creates.length - base.env.skillLimit;

        for (const skill of candidates) {
            if (needed.size >= deficit) {
                break;
            }

            needed.add(skill);
        }
    }

    const freed = candidates.filter((skill) => needed.has(skill));

    if (freed.length === 0) {
        return { entries: base.entries, freed };
    }

    if (freed.length === candidates.length) {
        return { entries: all.entries, freed };
    }

    const exact = await planWith(freed.map((skill) => skill.slug));

    return { entries: exact.entries, freed };
};
