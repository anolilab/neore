import { v } from "lunorash/server";
import { LunoraError } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx as MutationContext } from "../_generated/server";
import { internalAction, internalQuery } from "../_generated/server";
import { ActionCache } from "../lib/action-cache";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { omit } from "../lib/collections";
import { canReadSkill, canWriteSkill, isSkillOwner } from "./access";
import { getSkillsCacheGeneration, invalidateSkillsCache, SKILLS_CACHE_NAME } from "./cache";
import { FREE_SKILL_LIMIT } from "./constants";
import { getEnabledSkillsForSystemPrompt } from "./executor";
import { getToolRegistry } from "./jit-tool-loader";
import { deleteSkillRatings } from "./rating-cascade";
import { ensureSlugUnique, validateSlug, vSkillConfigInput } from "./validators";
import { systemDb } from "../lib/rls/scope";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { assertJsonWithinLimit, MAX_LENGTH, vJsonValue } from "../lib/validators";

/**
 * Throws NOT_FOUND — not FORBIDDEN — for a skill the caller may not read, so a
 * probe cannot tell a private skill from a missing one.
 */
const assertSkillReadable = async (context: MutationContext, skillId: Id<"skills">, userId: string, organizationId?: string | null): Promise<Doc<"skills">> => {
    const skill = await context.db.skills.findFirst({ where: { _id: skillId } });

    if (!skill || !canReadSkill(skill, { organizationId, userId })) {
        throw new LunoraError("NOT_FOUND", "Skill not found");
    }

    return skill;
};

/**
 * The tool names a skill may add or disable, for the skill editor.
 */
export const getAvailableSkillTools = authQuery
    .input({})
    .output(v.array(v.object({ category: v.string(), description: v.string(), name: v.string() })))
    .query(() => getToolRegistry());

export const getSkillsByUserInternal = internalQuery
    .input({
        maxSkills: v.number(),
        userId: v.string(),
    })
    .query(async ({ args: { maxSkills, userId }, ctx: context }) => {
        const { page: skills } = await context.db.skills.findMany({ limit: maxSkills, where: { userId } });

        return skills;
    });

export const getUserSkillsStateInternal = internalQuery
    .input({
        userId: v.string(),
    })
    .query(async ({ args: { userId }, ctx: context }) => {
        const userSkillsEntries = await context.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (query) => query.eq("userId", userId))
            .collect();

        return userSkillsEntries;
    });

export const getSkillsByOrganizationInternal = internalQuery
    .input({
        maxSkills: v.number(),
        organizationId: v.string(),
    })
    .query(async ({ args: { maxSkills, organizationId }, ctx: context }) => {
        const { page: skills } = await context.db.skills.findMany({ limit: maxSkills, where: { organizationId } });

        return skills;
    });

export const getSkillsByIdsInternal = internalQuery
    .input({
        skillIds: v.array(v.id("skills")),
    })
    .query(async ({ args: { skillIds }, ctx: context }) => {
        const skills = await Promise.all(skillIds.map((skillId) => context.db.skills.findFirst({ where: { _id: skillId } })));

        return skills.filter((skill): skill is Doc<"skills"> => skill !== null);
    });

export const calculateSkills = internalAction
    .input({
        category: v.optional(v.union(v.string(), v.null())),
        // Part of the cache key only; the list itself does not depend on it.
        generation: v.optional(v.string()),
        organizationId: v.optional(v.union(v.string(), v.null())),
        organizationRole: v.optional(v.union(v.string(), v.null())),
        sortBy: v.optional(v.union(v.literal("recent"), v.literal("mostUsed"), v.literal("alphabetical"))),
        userId: v.string(),
    })
    .action(async ({ args: { category, organizationId, organizationRole, sortBy = "recent", userId }, ctx: context }) => {
        const MAX_SKILLS = 200;

        // Fetch user and organization skills in parallel using internal queries
        const [userSkills, organizationSkills, userSkillsState] = await Promise.all([
            context.runQuery(internal.skills.functions.getSkillsByUserInternal, {
                maxSkills: MAX_SKILLS,
                userId,
            }),
            organizationId
                ? context.runQuery(internal.skills.functions.getSkillsByOrganizationInternal, {
                      maxSkills: MAX_SKILLS,
                      organizationId,
                  })
                : Promise.resolve([]),
            // Fetch userSkills entries to get enabled state
            context.runQuery(internal.skills.functions.getUserSkillsStateInternal, {
                userId,
            }),
        ]);

        // Combine and deduplicate. An organization's skills carry its id even when
        // private, so only the ones actually shared with it are listed here.
        const sharedOrganizationSkills = organizationSkills.filter((skill) => canReadSkill(skill, { organizationId, userId }));
        const listedIds = new Set<string>([...userSkills, ...sharedOrganizationSkills].map((skill) => skill._id as string));

        // Marketplace skills the user installed: another user's skill, reached only
        // through a `userSkills` row. Re-checked, because the owner may have made
        // it private since it was installed.
        const installedIds = userSkillsState.map((entry) => entry.skillId).filter((skillId) => !listedIds.has(skillId as string));
        const installedCandidates =
            installedIds.length > 0
                ? await context.runQuery(internal.skills.functions.getSkillsByIdsInternal, { skillIds: installedIds.slice(0, MAX_SKILLS) })
                : [];
        const installedSkills = installedCandidates.filter((skill) => skill.userId !== userId && canReadSkill(skill, { organizationId, userId }));
        const installedSet = new Set(installedSkills.map((skill) => skill._id as string));

        const allSkills = [...userSkills, ...sharedOrganizationSkills, ...installedSkills];
        const uniqueSkills = allSkills.filter((skill, index, self) => index === self.findIndex((s) => s._id === skill._id));

        // Create a map of skillId -> enabled state
        const enabledStateMap = new Map(userSkillsState.map((us) => [us.skillId, us.enabled]));

        // Filter by category if requested
        const filteredSkills = category ? uniqueSkills.filter((skill) => skill.category === category) : uniqueSkills;

        // Sort based on sortBy parameter
        filteredSkills.sort((a, b) => {
            switch (sortBy) {
                case "alphabetical": {
                    return a.name.localeCompare(b.name);
                }
                case "mostUsed": {
                    // Would need to join with skillStats - for now sort by creation time
                    return b._creationTime - a._creationTime;
                }
                default: {
                    return b._creationTime - a._creationTime;
                }
            }
        });

        // Add enabled state to each skill
        return filteredSkills.map((skill) => {
            return {
                ...skill,
                // Owner, or an admin of the organization it is shared with.
                canEdit: canWriteSkill(skill, { organizationId, organizationRole, userId }),
                // No `userSkills` row: the user's own skills default on (legacy rows
                // predate the row), anyone else's — an organization-shared one — off.
                // Sharing a skill never puts it into a member's prompt unasked.
                enabled: enabledStateMap.get(skill._id) ?? skill.userId === userId,
                // Installed from the marketplace: not editable here, fork to change it.
                isInstalled: installedSet.has(skill._id as string),
            };
        });
    });

/**
 * Get all skills for the current user
 * Uses ActionCache for efficient caching (30 second TTL)
 */
export const getSkills = authAction
    .use(rateLimit("library/read"))
    .input({
        category: v.optional(v.string().max(MAX_LENGTH.short)),
        sortBy: v.optional(v.union(v.literal("recent"), v.literal("mostUsed"), v.literal("alphabetical"))),
    })
    .action(async ({ args: { category, sortBy = "recent" }, ctx }): Promise<Doc<"skills">[]> => {
        const { userId } = ctx.user;

        // Handle anonymous users - return empty array if no userId
        if (!userId) {
            return [];
        }

        const organizationId = ctx.user.activeOrganization?.id;

        // Result type named — `new ActionCache(...)` without one defaults to
        // `unknown`, and `cache.fetch` then cannot satisfy the declared output.
        const cache = new ActionCache<
            {
                category: string | null;
                generation: string;
                organizationId: string | null;
                organizationRole: string | null;
                sortBy?: "alphabetical" | "mostUsed" | "recent";
                userId: string;
            },
            Doc<"skills">[]
        >(undefined, {
            action: internal.skills.functions.calculateSkills,
            name: SKILLS_CACHE_NAME,
            ttl: 30 * 1000, // 30 seconds
        });

        const skills = await cache.fetch(ctx, {
            category: category ?? null,
            // Keyed on the user's generation, so a write invalidates every
            // combination of the other args at once (see `skills/cache.ts`).
            generation: await getSkillsCacheGeneration(ctx, userId),
            organizationId: organizationId ?? null,
            organizationRole: ctx.user.activeOrganization?.role ?? null,
            sortBy,
            userId,
        });

        ctx.log.event("skills.list", { count: skills.length, hasCategory: category !== undefined, sortBy });

        return skills;
    });

/**
 * Get a single skill by ID with userSkills state and stats
 */
export const getSkill = authQuery
    .input({
        skillId: v.id("skills"),
    })
    .query(
        async ({
            args: { skillId },
            ctx,
        }): Promise<
            | (Doc<"skills"> & { enabled?: boolean; isOwner: true; stats?: Doc<"skillStats"> })
            | (Omit<Doc<"skills">, "organizationId" | "source" | "userId"> & { enabled?: boolean; isOwner: false; stats?: Doc<"skillStats"> })
            | null
        > => {
            const { userId } = ctx.user;
            const organizationId = ctx.user.activeOrganization?.id;

            const skill = await ctx.db.skills.findFirst({ where: { _id: skillId as Id<"skills"> } });

            if (!skill) {
                return null;
            }

            if (!canReadSkill(skill, { organizationId, userId })) {
                throw new LunoraError("FORBIDDEN", "Not authorized to view this skill");
            }

            // Get userSkills state and stats in parallel
            const [userSkill, stats] = await Promise.all([
                ctx.db
                    .query("userSkills")
                    .withIndex("by_user_and_skill", (query) => query.eq("userId", userId).eq("skillId", skillId))
                    .first(),
                ctx.db.skillStats.findFirst({ where: { skillId } }),
            ]);

            // A reader who is not the owner (a public or org-shared skill) gets the
            // skill without who owns it, which org it lives in, or where it came from
            // (a GitHub source can name a private repository) — the same line the
            // marketplace projection draws.
            if (!isSkillOwner(skill, { userId })) {
                return { ...omit(skill, ["organizationId", "source", "userId"]), enabled: userSkill?.enabled, isOwner: false, stats: stats ?? undefined };
            }

            return {
                ...skill,
                enabled: userSkill?.enabled,
                isOwner: true,
                stats: stats ?? undefined,
            };
        },
    );

/**
 * Get enabled skills metadata for system prompt (Level 1)
 * Returns only name, slug, description for minimal token overhead
 */
export const getEnabledSkillsMetadata = authQuery
    .input({})
    .output(v.array(v.object({ description: v.string(), name: v.string(), slug: v.string() })))
    .query(async ({ ctx }): Promise<{ description: string; name: string; slug: string }[]> => {
        const { userId } = ctx.user;

        if (!userId) {
            return [];
        }

        // One implementation with the chat pipeline, so this preview cannot drift
        // from what the model is actually shown.
        return await getEnabledSkillsForSystemPrompt(ctx, userId, ctx.user.activeOrganization?.id);
    });

/**
 * Create a new skill
 */
export const createSkill = authMutation
    .use(rateLimit("skills/create"))
    .input({
        category: v.optional(v.string().max(MAX_LENGTH.short)),
        config: v.optional(vSkillConfigInput),
        description: v.string().max(MAX_LENGTH.long),
        icon: v.optional(v.string().max(MAX_LENGTH.url)),
        instructions: v.string().max(MAX_LENGTH.document),
        name: v.string().max(MAX_LENGTH.short),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        slug: v.string().max(MAX_LENGTH.short),
        source: v.union(
            v.object({ type: v.literal("editor") }),
            v.object({
                commitSha: v.optional(v.string().max(MAX_LENGTH.short)),
                path: v.optional(v.string().max(MAX_LENGTH.key)),
                repoUrl: v.string().max(MAX_LENGTH.url),
                type: v.literal("github"),
            }),
            v.object({ originalSkillId: v.string().max(MAX_LENGTH.short), type: v.literal("official") }),
            v.object({ filename: v.string().max(MAX_LENGTH.short), type: v.literal("upload"), uploadedAt: v.number() }),
        ),
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
    })
    .output(v.id("skills"))
    .mutation(
        async ({
            args: { category, config, description, icon, instructions, name, organizationId, slug, source, tags, variables, version, visibility },
            ctx,
        }) => {
            const { userId } = ctx.user;
            const activeOrganizationId = ctx.user.activeOrganization?.id;

            // A caller-supplied organization must be the one they are acting in;
            // otherwise anyone could plant an "organization" skill in a foreign org.
            if (organizationId && organizationId !== activeOrganizationId) {
                throw new LunoraError("FORBIDDEN", "Not a member of that organization");
            }

            const organizationIdToUse = organizationId || activeOrganizationId;
            const now = ctx.now;

            // Validate slug format
            const slugValidation = validateSlug(slug);

            if (!slugValidation.valid) {
                throw new LunoraError("BAD_REQUEST", slugValidation.errors.join(", "));
            }

            // Check slug uniqueness
            await ensureSlugUnique(ctx, userId, slug);

            // Check skill limit for free users using aggregate
            const isPremium = ctx.user.plan === "premium" || ctx.user.isAdmin;

            if (!isPremium) {
                // The caller's own rows — what the owner policy admits; `count()` cannot run behind it.
                const totalCount = await systemDb(ctx).skills.count({ userId });

                if (totalCount >= FREE_SKILL_LIMIT) {
                    throw new LunoraError("UNPROCESSABLE", "Free accounts are limited to 5 skills. Upgrade to Pro for unlimited skills.");
                }
            }

            // Create skill
            const insertedSkillId = await ctx.db.insert("skills", {
                category,
                config,
                currentVersion: 1,
                description,
                icon,
                instructions,
                name,
                organizationId: organizationIdToUse,
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

            // Create skillStats entry
            await ctx.db.insert("skillStats", {
                skillId,
                usageCount: 0,
            });

            // Create userSkills entry (auto-enable when created)
            await ctx.db.insert("userSkills", {
                addedAt: now,
                autoRun: false,
                enabled: true,
                skillId,
                userId,
            });

            // Create initial history entry
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

            // Invalidate skills list cache
            await invalidateSkillsCache(ctx, userId);

            ctx.log.event("skills.create", { skillId });

            return skillId;
        },
    );

/**
 * Update an existing skill
 */
export const updateSkill = authMutation
    .use(rateLimit("skills/update"))
    .input({
        category: v.optional(v.string().max(MAX_LENGTH.short)),
        changeType: v.optional(v.union(v.literal("manual"), v.literal("import"), v.literal("restored"))),
        config: v.optional(vSkillConfigInput),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        icon: v.optional(v.string().max(MAX_LENGTH.url)),
        instructions: v.optional(v.string().max(MAX_LENGTH.document)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        note: v.optional(v.string().max(MAX_LENGTH.long)),
        skillId: v.id("skills"),
        slug: v.optional(v.string().max(MAX_LENGTH.short)),
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
    })
    .output(v.id("skills"))
    .mutation(
        async ({
            args: { category, changeType, config, description, icon, instructions, name, note, skillId, slug, tags, variables, version, visibility },
            ctx,
        }) => {
            const { userId } = ctx.user;
            const organizationId = ctx.user.activeOrganization?.id;
            const now = ctx.now;

            const existing = await ctx.db.skills.findFirst({ where: { _id: skillId as Id<"skills"> } });

            if (!existing) {
                throw new LunoraError("NOT_FOUND", "Skill not found");
            }

            if (!canWriteSkill(existing, { organizationId, organizationRole: ctx.user.activeOrganization?.role, userId })) {
                throw new LunoraError("FORBIDDEN", "Not authorized to update this skill");
            }

            // Re-scoping (e.g. publishing to the marketplace) is the owner's decision alone.
            if (visibility !== undefined && visibility !== existing.visibility && !isSkillOwner(existing, { organizationId, userId })) {
                throw new LunoraError("FORBIDDEN", "Only the owner can change a skill's visibility");
            }

            // Validate slug if changing
            if (slug !== undefined && slug !== existing.slug) {
                const slugValidation = validateSlug(slug);

                if (!slugValidation.valid) {
                    throw new LunoraError("BAD_REQUEST", slugValidation.errors.join(", "));
                }

                await ensureSlugUnique(ctx, existing.userId, slug, skillId);
            }

            // Check if content changed for history
            const isInstructionsChanged = instructions !== undefined && instructions !== existing.instructions;
            const isVariablesChanged = variables !== undefined && JSON.stringify(variables) !== JSON.stringify(existing.variables);
            const isConfigChanged = config !== undefined && JSON.stringify(config) !== JSON.stringify(existing.config);
            const shouldSaveHistory = isInstructionsChanged || isVariablesChanged || isConfigChanged;
            const newVersion = (existing.currentVersion || 1) + (shouldSaveHistory ? 1 : 0);

            // Save history entry if content changed
            if (shouldSaveHistory) {
                await ctx.db.insert("skillHistory", {
                    changeType: changeType || "manual",
                    config: config === undefined ? existing.config : config,
                    createdAt: now,
                    instructions: instructions === undefined ? existing.instructions : instructions,
                    note,
                    skillId,
                    userId,
                    variables: variables === undefined ? existing.variables : variables,
                    version: newVersion,
                });
            }

            // Update skill
            await ctx.db.patch(skillId, {
                ...(category !== undefined && { category }),
                ...(config !== undefined && { config }),
                ...(shouldSaveHistory && { currentVersion: newVersion }),
                ...(description !== undefined && { description }),
                ...(icon !== undefined && { icon }),
                ...(instructions !== undefined && { instructions }),
                ...(name !== undefined && { name }),
                ...(slug !== undefined && { slug }),
                ...(tags !== undefined && { tags }),
                ...(variables !== undefined && { variables }),
                ...(version !== undefined && { version }),
                ...(visibility !== undefined && { visibility }),
                updatedAt: now,
            });

            // Invalidate cache — the owner's too, when an organization admin edited it.
            await invalidateSkillsCache(ctx, userId);

            if (existing.userId !== userId) {
                await invalidateSkillsCache(ctx, existing.userId);
            }

            ctx.log.event("skills.update", { crossOwner: existing.userId !== userId, skillId });

            return skillId;
        },
    );

/**
 * Delete a skill
 */
export const deleteSkill = authMutation
    .use(rateLimit("skills/delete"))
    .input({
        skillId: v.id("skills"),
    })
    .mutation(async ({ args: { skillId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        const existing = await ctx.db.skills.findFirst({ where: { _id: skillId as Id<"skills"> } });

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "Skill not found");
        }

        if (!isSkillOwner(existing, { organizationId, userId })) {
            throw new LunoraError("FORBIDDEN", "Not authorized to delete this skill");
        }

        // Nothing cascades. Stats and the caller's own installation are removed
        // here; other users' `userSkills` rows live in their shards and are
        // filtered out on read, because `ctx.db.get` returns null for them.
        const [stats, userSkill] = await Promise.all([
            ctx.db.skillStats.findFirst({ where: { skillId } }),
            ctx.db
                .query("userSkills")
                .withIndex("by_user_and_skill", (query) => query.eq("userId", userId).eq("skillId", skillId))
                .first(),
        ]);

        // Every user's ratings of this skill go with it — they are only reachable
        // through `skillId`, so they must be gone before the skill row is.
        await deleteSkillRatings(ctx.db, skillId);

        // Imported additional files (`skills/io.ts`): the rows now, their objects once this commits.
        const { page: files } = await ctx.db.skillFiles.findMany({ where: { skillId } });

        await Promise.all(files.map((file) => ctx.db.delete(file._id)));
        await scheduleObjectDeletion(
            ctx,
            files.map((file) => file.storageId),
        );

        if (stats) {
            await ctx.db.delete(stats._id);
        }

        if (userSkill) {
            await ctx.db.delete(userSkill._id);
        }

        await ctx.db.delete(skillId);

        // Invalidate cache
        await invalidateSkillsCache(ctx, userId);

        ctx.log.event("skills.delete", { deletedFileCount: files.length, skillId });
    });

/**
 * Set skill enabled/disabled for current user
 */
export const setSkillEnabled = authMutation
    .use(rateLimit("skills/update"))
    .input({
        enabled: v.boolean(),
        skillId: v.id("skills"),
    })
    .mutation(async ({ args: { enabled, skillId }, ctx }) => {
        const { userId } = ctx.user;
        const now = ctx.now;

        await assertSkillReadable(ctx, skillId, userId, ctx.user.activeOrganization?.id);

        // Get or create userSkills entry
        const userSkill = await ctx.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (query) => query.eq("userId", userId).eq("skillId", skillId))
            .first();

        if (userSkill) {
            await ctx.db.patch(userSkill._id, { enabled });
        } else {
            await ctx.db.insert("userSkills", {
                addedAt: now,
                autoRun: false,
                enabled,
                skillId,
                userId,
            });
        }

        // Invalidate cache because enabled status affects Level 1 metadata query
        await invalidateSkillsCache(ctx, userId);

        ctx.log.event("skills.set_enabled", { enabled, skillId });
    });

/**
 * Set skill auto-run preference (Phase 2 feature, schema ready)
 */
export const setSkillAutoRun = authMutation
    .use(rateLimit("skills/update"))
    .input({
        autoRun: v.boolean(),
        skillId: v.id("skills"),
    })
    .mutation(async ({ args: { autoRun, skillId }, ctx }) => {
        const { userId } = ctx.user;
        const now = ctx.now;

        await assertSkillReadable(ctx, skillId, userId, ctx.user.activeOrganization?.id);

        // Get or create userSkills entry
        const userSkill = await ctx.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (query) => query.eq("userId", userId).eq("skillId", skillId))
            .first();

        if (userSkill) {
            await ctx.db.patch(userSkill._id, { autoRun });
        } else {
            await ctx.db.insert("userSkills", {
                addedAt: now,
                autoRun,
                enabled: true, // Enable by default when setting auto-run
                skillId,
                userId,
            });
        }

        ctx.log.event("skills.set_auto_run", { autoRun, skillId });
    });

export const getSkillCountInternal = internalQuery
    .input({
        userId: v.string(),
    })
    .query(async ({ args: { userId }, ctx: context }) => await context.db.skills.count({ userId }));

export const calculateSkillCount = internalAction
    .input({
        isPremium: v.boolean(),
        userId: v.string(),
    })
    .output(
        v.object({
            canCreate: v.boolean(),
            count: v.number(),
            isPremium: v.boolean(),
            limit: v.union(v.number(), v.null()),
        }),
    )
    .action(async ({ args: { isPremium, userId }, ctx: context }) => {
        // Use aggregate for efficient counting (O(log n) instead of O(n))
        const count = await context.runQuery(internal.skills.functions.getSkillCountInternal, {
            userId,
        });

        const limit = isPremium ? null : FREE_SKILL_LIMIT;
        const canCreate = isPremium || count < FREE_SKILL_LIMIT;

        return {
            canCreate,
            count,
            isPremium,
            limit,
        };
    });

/**
 * Get skill count and limit information for the current user
 * Uses ActionCache for efficient caching (30 second TTL)
 */
export const getSkillCount = authAction
    .use(rateLimit("library/read"))
    .output(v.object({ canCreate: v.boolean(), count: v.number(), isPremium: v.boolean(), limit: v.union(v.number(), v.null()) }))
    .action(async ({ ctx }) => {
        const { userId } = ctx.user;

        // Handle anonymous users - return limit info but can't create
        if (!userId) {
            return {
                canCreate: false,
                count: 0,
                isPremium: false,
                limit: FREE_SKILL_LIMIT,
            };
        }

        const isPremium = ctx.user.plan === "premium" || ctx.user.isAdmin;

        // Use ActionCache for efficient caching (30 second TTL - count changes frequently)
        const cache = new ActionCache<{ isPremium: boolean; userId: string }, { canCreate: boolean; count: number; isPremium: boolean; limit: null | number }>(
            undefined,
            {
                action: internal.skills.functions.calculateSkillCount,
                name: "skillCount",
                ttl: 30 * 1000, // 30 seconds
            },
        );

        const counts = await cache.fetch(ctx, { isPremium, userId });

        ctx.log.event("skills.count", { canCreate: counts.canCreate, count: counts.count, isPremium });

        return counts;
    });

export const recordSkillInvocation = authMutation
    .use(rateLimit("skills/invoke"))
    .input({
        durationMs: v.optional(v.number()),
        errorMessage: v.optional(v.string().max(MAX_LENGTH.text)),
        parameters: v.optional(vJsonValue),
        skillId: v.id("skills"),
        status: v.union(v.literal("completed"), v.literal("failed")),
        threadId: v.optional(v.id("threads")),
        trigger: v.union(v.literal("slash_command"), v.literal("auto_trigger")),
    })
    .mutation(async ({ args: { durationMs, errorMessage, parameters, skillId, status, threadId, trigger }, ctx }) => {
        assertJsonWithinLimit(parameters, "parameters");
        const { userId } = ctx.user;
        const now = ctx.now;

        // Without this, any caller could inflate any skill's usage count.
        await assertSkillReadable(ctx, skillId, userId, ctx.user.activeOrganization?.id);

        // Record invocation
        await ctx.db.insert("skillInvocations", {
            createdAt: now,
            durationMs,
            errorMessage,
            parameters,
            skillId,
            status,
            threadId,
            trigger,
            userId,
        });

        // Update skillStats
        const stats = await ctx.db.skillStats.findFirst({ where: { skillId } });

        if (stats) {
            await ctx.db.patch(stats._id, {
                lastUsedAt: now,
                usageCount: (stats.usageCount || 0) + 1,
            });
        }

        ctx.log.event("skills.record_invocation", { hasStats: Boolean(stats), skillId, status });
    });
