import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { isMarketplaceSkill, isSkillOwner } from "./access";
import { FREE_SKILL_LIMIT, MAX_SLUG_LENGTH } from "./constants";
import { invalidateSkillsCache } from "./cache";
import { forkSlug, isValidRating, summarizeRatings } from "./marketplace-logic";
import { vSkillConfig } from "./validators";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";

// ============================================================================
// Shapes
// ============================================================================
//
// Every marketplace read returns an explicit projection. Spreading the row would
// hand the owner's `userId` and `organizationId` to every browsing user.

const MAX_PAGE_SIZE = 50;
const BROWSE_WINDOW = 200;

const vMarketplaceSkillSummary = v.object({
    _id: v.id("skills"),
    category: v.optional(v.string()),
    description: v.string(),
    icon: v.optional(v.string()),
    name: v.string(),
    rating: v.number(),
    ratingCount: v.number(),
    slug: v.string(),
    tags: v.optional(v.array(v.string())),
    usageCount: v.number(),
});

const vSkillVariable = v.object({
    defaultValue: v.optional(v.string()),
    description: v.optional(v.string()),
    name: v.string(),
    required: v.optional(v.boolean()),
});

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(Math.trunc(limit ?? 20), 1), MAX_PAGE_SIZE);

const toSummary = (skill: Doc<"skills">, stats: Doc<"skillStats"> | null) => {
    return {
        _id: skill._id,
        category: skill.category,
        description: skill.description,
        icon: skill.icon,
        name: skill.name,
        rating: stats?.rating ?? 0,
        ratingCount: stats?.ratingCount ?? 0,
        slug: skill.slug,
        tags: skill.tags,
        usageCount: stats?.usageCount ?? 0,
    };
};

// ============================================================================
// Public Marketplace Queries
// ============================================================================

/**
 * Browse marketplace skills with optional category filter.
 */
export const browseSkills = authQuery
    .input({
        category: v.optional(v.string().max(MAX_LENGTH.short)),
        limit: v.optional(v.number()),
    })
    .output(v.object({ hasMore: v.boolean(), skills: v.array(vMarketplaceSkillSummary) }))
    .query(async ({ args: input, ctx }) => {
        const limit = clampLimit(input.limit);

        const { page: allPublic } = await ctx.db.skills.findMany({ limit: BROWSE_WINDOW, where: { visibility: "public" } });

        // Apply category filter if provided
        const filtered = input.category ? allPublic.filter((s) => s.category === input.category) : allPublic;

        const skills = filtered.slice(0, limit + 1);

        const skillsWithStats = await Promise.all(
            skills.slice(0, limit).map(async (skill) => toSummary(skill, await ctx.db.skillStats.findFirst({ where: { skillId: skill._id } }))),
        );

        return {
            hasMore: skills.length > limit,
            skills: skillsWithStats,
        };
    });

/**
 * Search marketplace skills by name or description.
 */
export const searchSkills = authQuery
    .input({
        limit: v.optional(v.number()),
        query: v.string().max(MAX_LENGTH.long),
    })
    .output(v.array(vMarketplaceSkillSummary))
    .query(async ({ args: input, ctx }) => await searchMarketplaceSkills(ctx, input.query, input.limit));

/**
 * The body of `searchSkills`, shared with the agent builder's "use this instead"
 * recommendations so both apply the same public-only filter.
 */
export const searchMarketplaceSkills = async (ctx: QueryContext, rawQuery: string, rawLimit?: number) => {
    const limit = clampLimit(rawLimit);
    const query = rawQuery.trim();

    if (!query) {
        return [];
    }

    // The search indexes cannot filter on visibility, so private matches share
    // the window with public ones. Over-fetch so they do not crowd public
    // results out, then drop everything that is not public.
    const window = limit * 5;
    const nameResults = await ctx.db.skills.withSearchIndex("search_skills_name", (q) => q.search("name", query)).take(window);
    const descResults = await ctx.db.skills.withSearchIndex("search_skills_description", (q) => q.search("description", query)).take(window);

    const seen = new Set<string>();
    const merged = [...nameResults, ...descResults].filter((skill) => {
        if (seen.has(skill._id as string) || !isMarketplaceSkill(skill)) {
            return false;
        }

        seen.add(skill._id as string);

        return true;
    });

    return await Promise.all(
        merged.slice(0, limit).map(async (skill) => toSummary(skill, await ctx.db.skillStats.findFirst({ where: { skillId: skill._id } }))),
    );
};

/**
 * Get detailed info about a marketplace skill.
 */
export const getSkillDetail = authQuery
    .input({
        skillId: v.id("skills"),
    })
    .output(
        v.object({
            _id: v.id("skills"),
            category: v.optional(v.string()),
            config: v.optional(vSkillConfig),
            currentVersion: v.optional(v.number()),
            description: v.string(),
            icon: v.optional(v.string()),
            instructions: v.string(),
            isEnabled: v.boolean(),
            isInstalled: v.boolean(),
            isOwner: v.boolean(),
            myRating: v.union(v.number(), v.null()),
            name: v.string(),
            rating: v.number(),
            ratingCount: v.number(),
            slug: v.string(),
            tags: v.optional(v.array(v.string())),
            usageCount: v.number(),
            variables: v.optional(v.array(vSkillVariable)),
        }),
    )
    .query(async ({ args: input, ctx }) => {
        const skill = await ctx.db.skills.findFirst({ where: { _id: input.skillId as Id<"skills"> } });

        if (!isMarketplaceSkill(skill)) {
            throw new LunoraError("NOT_FOUND", "Skill not found in marketplace");
        }

        const [stats, installation, myRating] = await Promise.all([
            ctx.db.skillStats.findFirst({ where: { skillId: skill._id } }),
            ctx.db
                .query("userSkills")
                .withIndex("by_user_and_skill", (q) => q.eq("userId", ctx.user.userId).eq("skillId", skill._id))
                .first(),
            ctx.db.skillRatings.findFirst({ where: { skillId: skill._id, userId: ctx.user.userId } }),
        ]);

        return {
            ...toSummary(skill, stats),
            config: skill.config,
            currentVersion: skill.currentVersion,
            instructions: skill.instructions,
            isEnabled: installation?.enabled ?? false,
            isInstalled: !!installation,
            isOwner: isSkillOwner(skill, { userId: ctx.user.userId }),
            myRating: myRating?.rating ?? null,
            variables: skill.variables,
        };
    });

// ============================================================================
// Installation & Forking
// ============================================================================

/**
 * Install a marketplace skill for the current user.
 */
export const installSkill = authMutation
    .use(rateLimit("skills/update"))
    .input({
        skillId: v.id("skills"),
    })
    .output(v.object({ alreadyInstalled: v.boolean(), skillId: v.id("skills") }))
    .mutation(async ({ args: input, ctx }) => {
        const skillId = input.skillId as Id<"skills">;
        const skill = await ctx.db.skills.findFirst({ where: { _id: skillId } });

        if (!isMarketplaceSkill(skill)) {
            throw new LunoraError("NOT_FOUND", "Skill not found in marketplace");
        }

        const existing = await ctx.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (q) => q.eq("userId", ctx.user.userId).eq("skillId", skillId))
            .first();

        if (existing) {
            // Re-enable if disabled
            if (!existing.enabled) {
                await ctx.db.patch(existing._id, { enabled: true });
                await invalidateSkillsCache(ctx, ctx.user.userId);
            }

            ctx.log.event("skills.install", { alreadyInstalled: true, skillId });

            return { alreadyInstalled: true, skillId };
        }

        await ctx.db.insert("userSkills", {
            addedAt: ctx.now,
            enabled: true,
            skillId,
            userId: ctx.user.userId,
        });

        // Installed skills are listed under "My skills", so the cached list is stale.
        await invalidateSkillsCache(ctx, ctx.user.userId);

        ctx.log.event("skills.install", { alreadyInstalled: false, skillId });

        return { alreadyInstalled: false, skillId };
    });

/**
 * Remove a marketplace skill from the current user's installed set.
 */
export const uninstallSkill = authMutation
    .use(rateLimit("skills/update"))
    .input({
        skillId: v.id("skills"),
    })
    .output(v.object({ removed: v.boolean() }))
    .mutation(async ({ args: input, ctx }) => {
        // Only ever touches the caller's own row, so no visibility check is needed —
        // and none is wanted: a skill made private after install must stay removable.
        const existing = await ctx.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (q) => q.eq("userId", ctx.user.userId).eq("skillId", input.skillId))
            .first();

        if (!existing) {
            ctx.log.event("skills.uninstall", { removed: false, skillId: input.skillId });

            return { removed: false };
        }

        await ctx.db.delete(existing._id);
        await invalidateSkillsCache(ctx, ctx.user.userId);

        ctx.log.event("skills.uninstall", { removed: true, skillId: input.skillId });

        return { removed: true };
    });

/**
 * Fork a marketplace skill — creates a private copy for customization.
 */
export const forkSkill = authMutation
    .use(rateLimit("skills/create"))
    .input({
        skillId: v.id("skills"),
    })
    .output(v.object({ forkedSkillId: v.id("skills") }))
    .mutation(async ({ args: input, ctx }) => {
        const skillId = input.skillId as Id<"skills">;
        const skill = await ctx.db.skills.findFirst({ where: { _id: skillId } });
        const { userId } = ctx.user;

        if (!isMarketplaceSkill(skill)) {
            throw new LunoraError("NOT_FOUND", "Skill not found in marketplace");
        }

        // A fork is a new skill, so it counts against the same limit `createSkill` enforces.
        const isPremium = ctx.user.plan === "premium" || ctx.user.isAdmin;

        // The caller's own rows — what the owner policy admits; `count()` cannot run behind it.
        if (!isPremium && (await systemDb(ctx).skills.count({ userId })) >= FREE_SKILL_LIMIT) {
            throw new LunoraError("UNPROCESSABLE", "Free accounts are limited to 5 skills. Upgrade to Pro for unlimited skills.");
        }

        const now = ctx.now;
        const forkedId = (await ctx.db.insert("skills", {
            category: skill.category,
            config: skill.config,
            currentVersion: 1,
            description: skill.description,
            icon: skill.icon,
            instructions: skill.instructions,
            name: `${skill.name} (fork)`,
            slug: forkSlug(skill.slug, now, MAX_SLUG_LENGTH),
            source: {
                originalSkillId: skillId as string,
                type: "official",
            },
            tags: skill.tags,
            updatedAt: now,
            userId,
            variables: skill.variables,
            visibility: "private",
        })) as Id<"skills">;

        await ctx.db.insert("skillStats", { skillId: forkedId, usageCount: 0 });

        await ctx.db.insert("userSkills", {
            addedAt: now,
            enabled: true,
            skillId: forkedId,
            userId,
        });

        await ctx.db.insert("skillHistory", {
            changeType: "created",
            config: skill.config,
            createdAt: now,
            instructions: skill.instructions,
            note: `Forked from ${skill.slug}`,
            skillId: forkedId,
            userId,
            variables: skill.variables,
            version: 1,
        });

        // The fork is the caller's own skill, so their cached skills list is now stale.
        await invalidateSkillsCache(ctx, userId);

        ctx.log.event("skills.fork", { forkedSkillId: forkedId });

        return { forkedSkillId: forkedId };
    });

/**
 * Rate a marketplace skill (1–5 stars). Owners cannot rate their own skills.
 */
export const rateSkill = authMutation
    .use(rateLimit("skills/update"))
    .input({
        rating: v.number(),
        skillId: v.id("skills"),
    })
    .output(v.object({ rating: v.number(), ratingCount: v.number(), updated: v.boolean() }))
    .mutation(async ({ args: input, ctx }) => {
        const skillId = input.skillId as Id<"skills">;
        const skill = await ctx.db.skills.findFirst({ where: { _id: skillId } });
        const { userId } = ctx.user;

        if (!isMarketplaceSkill(skill)) {
            throw new LunoraError("NOT_FOUND", "Skill not found in marketplace");
        }

        if (!isValidRating(input.rating)) {
            throw new LunoraError("BAD_REQUEST", "Rating must be a whole number from 1 to 5");
        }

        if (isSkillOwner(skill, { userId })) {
            throw new LunoraError("FORBIDDEN", "You cannot rate your own skill");
        }

        // Every rating of the skill, not just the caller's: the aggregate is
        // re-derived from the rows (`summarizeRatings`, the same algorithm the
        // erasure cascade uses) rather than folded into the stored average, so
        // one rule computes it and a drifted stats row heals on the next rating.
        const [ratings, stats] = await Promise.all([ctx.db.skillRatings.findMany({ where: { skillId } }), ctx.db.skillStats.findFirst({ where: { skillId } })]);
        const existingRating = ratings.page.find((entry) => entry.userId === userId);
        const now = ctx.now;

        if (existingRating) {
            await ctx.db.patch(existingRating._id, { rating: input.rating, updatedAt: now });
        } else {
            await ctx.db.insert("skillRatings", { createdAt: now, rating: input.rating, skillId, userId });
        }

        // The caller's old row (if any) is replaced by the rating just written.
        const next = summarizeRatings([...ratings.page.filter((entry) => entry.userId !== userId), { rating: input.rating, userId }]);

        if (stats) {
            await ctx.db.patch(stats._id, next);
        } else {
            await ctx.db.insert("skillStats", { ...next, skillId, usageCount: 0 });
        }

        ctx.log.event("skills.rate", { rating: input.rating, skillId, updated: !!existingRating });

        return { ...next, updated: !!existingRating };
    });
