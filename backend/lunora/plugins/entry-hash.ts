/**
 * The content hash of one plugin entry. Install stores it on the child's link, and update compares it with the child's
 * live hash, so the two must be computed from the same fields. A skill's content is its content fields only (the owner,
 * flags and ids on its row are not content), so the file's entry and the row are read through the same field list.
 */
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

/** The hash of an entry as the file defines it. A skill is hashed over its content fields, the same way its row is. */
export const entryHash = async (entry: PlanEntry): Promise<string> => {
    if (entry.plan?.kind === "skill") {
        return await contentHash(skillContent(entry.plan.create));
    }

    return await contentHash(entry.plan?.create ?? null);
};

/** A skill's live hash, read back from its row. */
export const skillRowHash = async (row: SkillContent): Promise<string> => await contentHash(skillContent(row));
