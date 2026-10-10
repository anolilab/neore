import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { QueryCtx as QueryContext } from "../_generated/server";
import { MAX_DESCRIPTION_LENGTH, MAX_SLUG_LENGTH, RESERVED_SLUGS, SLUG_REGEX } from "./constants";
import { systemDb } from "../lib/rls/scope";

/**
 * Validates skill slug format
 * - Max 64 characters
 * - Lowercase letters, numbers, hyphens only
 * - No leading/trailing hyphens
 * - No consecutive hyphens (--)
 * - No reserved words.
 */
export const validateSlug = (slug: string): { errors: string[]; valid: boolean } => {
    const errors: string[] = [];

    if (slug.length > MAX_SLUG_LENGTH) {
        errors.push(`Slug must be ${MAX_SLUG_LENGTH} characters or less`);
    }

    if (!SLUG_REGEX.test(slug)) {
        errors.push("Slug must contain only lowercase letters, numbers, and hyphens");
    }

    if (RESERVED_SLUGS.includes(slug.toLowerCase())) {
        errors.push(`Slug '${slug}' is reserved and cannot be used`);
    }

    return {
        errors,
        valid: errors.length === 0,
    };
};

/**
 * Ensures skill slug is unique for the user.
 * @throws LunoraError with code CONFLICT if slug already exists
 */
export const ensureSlugUnique = async (context: { db: QueryContext["db"] }, userId: string, slug: string, excludeSkillId?: string): Promise<void> => {
    // A uniqueness DECISION over `userId`'s skills — an org admin editing another
    // member's skill checks the OWNER's slugs, which row-level security hides.
    const existing = await systemDb(context).skills.findFirst({ where: { slug, userId } });

    if (existing && existing._id !== excludeSkillId) {
        throw new LunoraError("CONFLICT", `A skill with slug '${slug}' already exists`);
    }
};

/**
 * Validates description length for metadata injection.
 */
export const validateDescription = (description: string): { errors: string[]; valid: boolean } => {
    const errors: string[] = [];

    if (description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`Description must be ${MAX_DESCRIPTION_LENGTH} characters or less`);
    }

    return {
        errors,
        valid: errors.length === 0,
    };
};

/**
 * Validates SKILL.md YAML frontmatter
 * Ensures required fields are present and valid.
 */
export const validateSKILLmdFrontmatter = (frontmatter: {
    description?: unknown;
    name?: unknown;
}): {
    errors: string[];
    valid: boolean;
} => {
    const errors: string[] = [];

    if (!frontmatter.name || typeof frontmatter.name !== "string") {
        errors.push("Field 'name' is required and must be a string");
    }

    if (!frontmatter.description || typeof frontmatter.description !== "string") {
        errors.push("Field 'description' is required and must be a string");
    }

    if (frontmatter.description && typeof frontmatter.description === "string") {
        const descValidation = validateDescription(frontmatter.description);

        errors.push(...descValidation.errors);
    }

    return {
        errors,
        valid: errors.length === 0,
    };
};

/**
 * A skill's run config — model, reasoning effort, search mode and tool
 * adjustments. The one shape the `skills` row, its history, a builder draft and
 * every procedure passing a config around share.
 *
 * Spelled out inline, not built from a shared fields const: codegen resolves an
 * object literal here, and a const it names degrades the generated `Doc` type
 * to `{}`.
 */
export const vSkillConfig = v.object({
    additionalTools: v.optional(v.array(v.string())),
    disabledTools: v.optional(v.array(v.string())),
    preferredModel: v.optional(v.string()),
    reasoningEffort: v.optional(v.number()),
    searchMode: v.optional(v.string()),
    /** Voice the client speaks this skill's replies in (a browser `speechSynthesis` voice name, or a BCP 47 language tag). */
    voice: v.optional(v.string()),
});

export type SkillConfig = Infer<typeof vSkillConfig>;

/** {@link vSkillConfig} as a client sends it: reasoning effort is range-checked. */
export const vSkillConfigInput = v.object({
    additionalTools: v.optional(v.array(v.string())),
    disabledTools: v.optional(v.array(v.string())),
    preferredModel: v.optional(v.string()),
    reasoningEffort: v.optional(
        v.number().check((n) => n >= 0 && n <= 4, { message: "reasoningEffort must be between 0 and 4", schema: { maximum: 4, minimum: 0 } }),
    ),
    searchMode: v.optional(v.string()),
    voice: v.optional(v.string().check((value) => value.length <= 200, { message: "voice must be 200 characters or less", schema: { maxLength: 200 } })),
});
