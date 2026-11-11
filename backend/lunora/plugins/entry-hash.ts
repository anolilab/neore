/**
 * The content hash of one plugin entry, computed the same way at install and at update, from the same fields.
 * A child's live hash is computed from its row with the same field list, so an edit to the row shows as a change.
 */
import type { PlanEntry } from "../skills/bundle-plan";
import { contentHash } from "./logic";

/** The hash of an entry as the file defines it. Install stores it on the child's link; update compares against it. */
export const entryHash = async (entry: PlanEntry): Promise<string> => await contentHash(entry.plan?.create ?? null);

/** The fields a skill's file entry defines, read back from its row. Anything else on the row (ids, owner, flags) is not content. */
export const skillRowHash = async (row: {
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
}): Promise<string> =>
    await contentHash({
        category: row.category,
        config: row.config,
        description: row.description,
        icon: row.icon,
        instructions: row.instructions,
        name: row.name,
        slug: row.slug,
        tags: row.tags,
        variables: row.variables,
        version: row.version,
    });
