import { v } from "lunorash/server";
import { LunoraError } from "lunorash/server";
import type { Infer } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx as MutationContext } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { rateLimitGuard } from "../lib/rate-limiter";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { invalidateSkillsCache } from "./cache";
import { FREE_SKILL_LIMIT } from "./constants";
import { ensureSlugUnique, validateSlug, vSkillConfigInput } from "./validators";

/** The sources a person may create a skill from. A `plugin` source is never accepted here, only by the internal wrapper below. */
const vPublicSkillSource = v.union(
    v.object({ type: v.literal("editor") }),
    v.object({
        commitSha: v.optional(v.string().max(MAX_LENGTH.short)),
        path: v.optional(v.string().max(MAX_LENGTH.key)),
        repoUrl: v.string().max(MAX_LENGTH.url),
        type: v.literal("github"),
    }),
    v.object({ originalSkillId: v.string().max(MAX_LENGTH.short), type: v.literal("official") }),
    v.object({ filename: v.string().max(MAX_LENGTH.short), type: v.literal("upload"), uploadedAt: v.number() }),
);

const vPluginSkillSource = v.object({ type: v.literal("plugin"), version: v.string().max(MAX_LENGTH.short) });

/** The fields of a skill a create call takes, shared by the public procedure and the internal wrapper. */
export const skillCreateFields = {
    category: v.optional(v.string().max(MAX_LENGTH.short)),
    config: v.optional(vSkillConfigInput),
    description: v.string().max(MAX_LENGTH.long),
    /** Defaults to on. `false` creates the skill switched off, so it reaches no system prompt until the user turns it on. */
    enabled: v.optional(v.boolean()),
    icon: v.optional(v.string().max(MAX_LENGTH.url)),
    instructions: v.string().max(MAX_LENGTH.document),
    name: v.string().max(MAX_LENGTH.short),
    organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
    slug: v.string().max(MAX_LENGTH.short),
    source: vPublicSkillSource,
    tags: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    variables: v.optional(
        v.array(
            v.object({
                defaultValue: v.optional(v.string().max(MAX_LENGTH.document)),
                description: v.optional(v.string().max(MAX_LENGTH.long)),
                name: v.string().check((s) => s.length > 0, { message: "Variable name is required", schema: { minLength: 1 } }),
                required: v.optional(v.boolean()),
            }),
        ),
    ),
    version: v.optional(v.string().max(MAX_LENGTH.short)),
    visibility: v.optional(v.union(v.literal("private"), v.literal("organization"), v.literal("public"))),
};

const vSkillCreateArgs = v.object({ ...skillCreateFields });

/** Every source a stored skill row can carry at create time: the public ones, and a plugin's. */
const vSkillRowSource = v.union(vPublicSkillSource, vPluginSkillSource);

export type SkillRowArgs = Omit<Infer<typeof vSkillCreateArgs>, "source"> & { source: Infer<typeof vSkillRowSource> };

/** Who the new row belongs to. The caller stamps it from its own identity, never from request input. */
export interface SkillOwner {
    activeOrganizationId?: string;
    isPremium: boolean;
    userId: string;
}

/** The plugin link a row carries when an install created it. */
export interface PluginLink {
    pluginInstallId: string;
    pluginMarker: string;
}

/**
 * Creates a skill and its bookkeeping rows (stats, the owner's enabled row, the first history entry). Shared by
 * the public `createSkill` and the plugin wrapper, so both create a row the same way.
 */
export const insertSkill = async (ctx: MutationContext, owner: SkillOwner, args: SkillRowArgs, plugin?: PluginLink): Promise<Id<"skills">> => {
    const { category, config, description, enabled, icon, instructions, name, organizationId, slug, source, tags, variables, version, visibility } = args;
    const { userId } = owner;

    // A caller-supplied organization must be the one they are acting in;
    // otherwise anyone could plant an "organization" skill in a foreign org.
    if (organizationId && organizationId !== owner.activeOrganizationId) {
        throw new LunoraError("FORBIDDEN", "Not a member of that organization");
    }

    const organizationIdToUse = organizationId || owner.activeOrganizationId;
    const { now } = ctx;

    const slugValidation = validateSlug(slug);

    if (!slugValidation.valid) {
        throw new LunoraError("BAD_REQUEST", slugValidation.errors.join(", "));
    }

    await ensureSlugUnique(ctx, userId, slug);

    if (!owner.isPremium) {
        // The caller's own rows — what the owner policy admits; `count()` cannot run behind it.
        const totalCount = await systemDb(ctx).skills.count({ userId });

        if (totalCount >= FREE_SKILL_LIMIT) {
            throw new LunoraError("UNPROCESSABLE", "Free accounts are limited to 5 skills. Upgrade to Pro for unlimited skills.");
        }
    }

    const insertedSkillId = await ctx.db.insert("skills", {
        category,
        config,
        currentVersion: 1,
        description,
        icon,
        instructions,
        name,
        organizationId: organizationIdToUse,
        pluginInstallId: plugin?.pluginInstallId,
        pluginMarker: plugin?.pluginMarker,
        slug,
        source,
        tags,
        updatedAt: now,
        userId,
        variables,
        version,
        visibility: visibility ?? "private",
    });

    const skillId = insertedSkillId as Id<"skills">;

    await ctx.db.insert("skillStats", {
        skillId,
        usageCount: 0,
    });

    // The owner's enabled row (on unless the caller asked for it off).
    await ctx.db.insert("userSkills", {
        addedAt: now,
        autoRun: false,
        enabled: enabled ?? true,
        skillId,
        userId,
    });

    await ctx.db.insert("skillHistory", {
        changeType: "created",
        config,
        createdAt: now,
        instructions,
        note: "Initial version",
        skillId,
        userId,
        variables,
        version: 1,
    });

    await invalidateSkillsCache(ctx, userId);

    ctx.log.event("skills.create", { skillId });

    return skillId;
};

/**
 * Creates a skill for a plugin install. Called from an action, which stamps the caller's identity. A skill with the same
 * marker is returned as it is, so a retried install never makes a second copy and spends no rate-limit budget on the re-find.
 */
export const createPluginSkill = internalMutation
    .input({
        ...skillCreateFields,
        isPremium: v.boolean(),
        plan: v.optional(v.string().max(MAX_LENGTH.short)),
        pluginInstallId: v.string().max(MAX_LENGTH.id),
        pluginMarker: v.string().max(MAX_LENGTH.short),
        source: vPluginSkillSource,
        userId: v.string().max(MAX_LENGTH.id),
        activeOrganizationId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.id("skills"))
    .mutation(async ({ args: { activeOrganizationId, isPremium, pluginInstallId, pluginMarker, plan, source, userId, ...fields }, ctx }) => {
        const existing = await ctx.db.skills.findFirst({ where: { pluginMarker } });

        if (existing) {
            if (existing.userId !== userId) {
                throw new LunoraError("FORBIDDEN", "That plugin skill belongs to another account");
            }

            return existing._id as Id<"skills">;
        }

        await rateLimitGuard({ ...ctx, rateLimitKey: "skills/create", user: { plan, userId } } as never);

        return await insertSkill(ctx, { activeOrganizationId, isPremium, userId }, { ...fields, source }, { pluginInstallId, pluginMarker });
    });
