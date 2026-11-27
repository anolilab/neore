/**
 * Skills an update removes before it creates anything. An update that swaps one skill for another would otherwise run into the
 * free skill limit, and the new skill would take a "-2" slug, because the dropped skill is still there while the new one is made.
 *
 * Only a skill that is SURE to go is removed early: created, no step in flight on it, unedited, private, and named by none of the
 * owner's group chats according to a complete participant index (`chat/group/skill-index.ts`). Without a complete index nothing is
 * sure, and the update keeps its order (create, then remove). `previewUpdate`, `updatePlugin` and the slug planning all take the
 * freed slugs from {@link freedSkills}, so the three plan the same slugs; the slug is part of the skill's hash.
 */
import { entryKey } from "../skills/bundle-plan";
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
