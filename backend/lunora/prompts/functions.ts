import { throwBadRequest, throwUnauthorized } from "../lib/error-helpers";
import { DEFAULT_PROMPT_IMPROVEMENT_MODEL } from "@neore/ai/constants";
import { v } from "lunorash/server";
import { LunoraError } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx as ActionContext, MutationCtx as MutationContext } from "../_generated/server";
import { internalAction, internalQuery } from "../_generated/server";
import { requireOwnedThread } from "../agent/thread-read-access";
import { assertOwnOrganizationId } from "../auth/lib/organization-helpers";
import getAgent from "../chat/lib/get-agent";
import { gatewayFetch } from "../lib/services";
import { ActionCache, cacheKeyFor } from "../lib/action-cache";
import { compareStrings } from "../lib/collections";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { checkRateLimit, getRateLimitKey } from "../lib/rate-limiter";
import { FREE_PROMPT_LIMIT, VARIABLE_REGEX } from "./constants";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";

// `prompts`, `promptHistory` and `userVariableDefaults` are `.global()` (D1):
// they have no legacy `ctx.db.query(...)` reader, so every read goes through the
// ORM facade. These orders reproduce the index walks the old reads relied on.

/** `by_user_and_favorite` / `by_organization_and_favorite`, walked descending. */
const PROMPTS_BY_FAVORITE_DESC: [{ isFavorite: "desc" }, { _creationTime: "desc" }] = [{ isFavorite: "desc" }, { _creationTime: "desc" }];

/**
 * `by_user_and_organization`, walked ascending: an absent `organizationId`
 * sorts first (NULL in SQLite, `undefined` in the old reader), so `.first()`
 * still prefers a user's personal row over an organization row they wrote.
 */
const USER_DEFAULTS_INDEX_ORDER: [{ organizationId: "asc" }, { _creationTime: "asc" }] = [{ organizationId: "asc" }, { _creationTime: "asc" }];

/**
 * Free accounts hold at most `FREE_PROMPT_LIMIT` prompts. Every path that adds
 * one goes through here — `duplicatePrompt` used to skip it.
 */
const assertPromptQuota = async (ctx: MutationContext & { user: { isAdmin: boolean; plan?: "premium" | null; userId: string } }): Promise<void> => {
    if (ctx.user.plan === "premium" || ctx.user.isAdmin) {
        return;
    }

    // Only "at least the limit" matters, so read at most that many rows.
    const { page: existing } = await ctx.db.prompts.findMany({ limit: FREE_PROMPT_LIMIT, where: { userId: ctx.user.userId } });

    if (existing.length >= FREE_PROMPT_LIMIT) {
        throw new LunoraError("UNPROCESSABLE", "Free accounts are limited to 3 prompts. Upgrade to Pro for unlimited prompts.");
    }
};

/**
 * Invalidate prompt tags cache using action-cache
 * Call this whenever prompts are created, updated, or deleted.
 */
const invalidatePromptTagsCache = async (context: ActionContext | MutationContext, userId: string, organizationId?: string | null) => {
    const cacheName = "promptTags";
    const cacheKey = JSON.stringify({ organizationId: organizationId ?? null, userId });

    // Remove cache entry using action-cache
    await context.runMutation(internal.lib.action_cache.remove, { key: await cacheKeyFor(cacheName, cacheKey) });
};

/**
 * Invalidate prompts list cache using action-cache
 * Call this whenever prompts are created, updated, or deleted
 * Removes all cache entries for this user/org (different sortBy/favoriteOnly combinations).
 */
const invalidatePromptsCache = async (context: ActionContext | MutationContext, userId: string, organizationId?: string | null) => {
    const cacheName = "prompts";

    // Remove all cache entries for this user/org by removing with prefix
    // ActionCache uses the full key including all args, so we need to remove all variations
    const sortOptions = ["recent", "mostUsed", "recentlyUsed", "alphabetical"];
    const favoriteOptions = [true, false, null];

    const invalidations: Promise<unknown>[] = [];

    for (const sortBy of sortOptions) {
        for (const favoriteOnly of favoriteOptions) {
            const cacheKey = JSON.stringify({
                favoriteOnly: favoriteOnly === null ? null : favoriteOnly,
                organizationId: organizationId ?? null,
                sortBy,
                userId,
            });

            invalidations.push(context.runMutation(internal.lib.action_cache.remove, { key: await cacheKeyFor(cacheName, cacheKey) }));
        }
    }

    await Promise.all(invalidations);
};

export const calculatePrompts = internalAction
    .input({
        favoriteOnly: v.optional(v.union(v.boolean(), v.null())),
        organizationId: v.optional(v.union(v.string(), v.null())),
        sortBy: v.optional(v.union(v.literal("recent"), v.literal("mostUsed"), v.literal("recentlyUsed"), v.literal("alphabetical"))),
        userId: v.string(),
    })
    .action(async ({ args: { favoriteOnly, organizationId, sortBy = "recent", userId }, ctx: context }) => {
        const MAX_PROMPTS = 200;

        // Fetch user and organization prompts in parallel using internal queries
        const [userPrompts, organizationPrompts] = await Promise.all([
            context.runQuery(internal.prompts.functions.getPromptsByUserInternal, {
                maxPrompts: MAX_PROMPTS,
                userId,
            }),
            organizationId
                ? context.runQuery(internal.prompts.functions.getPromptsByOrganizationInternal, {
                      maxPrompts: MAX_PROMPTS,
                      organizationId,
                  })
                : Promise.resolve([]),
        ]);

        // Combine and deduplicate
        const allPrompts = [...userPrompts, ...organizationPrompts];
        const uniquePrompts = allPrompts.filter((prompt, index, self) => index === self.findIndex((p) => p._id === prompt._id));

        // Filter by favorite if requested
        const filteredPrompts = favoriteOnly ? uniquePrompts.filter((prompt) => prompt.isFavorite === true) : uniquePrompts;

        // Sort based on sortBy parameter (favorites always first)
        filteredPrompts.sort((a, b) => {
            // Favorites always come first
            if (a.isFavorite && !b.isFavorite) {
                return -1;
            }

            if (!a.isFavorite && b.isFavorite) {
                return 1;
            }

            // Then sort by the specified criteria
            switch (sortBy) {
                case "alphabetical": {
                    return a.name.localeCompare(b.name);
                }
                case "mostUsed": {
                    return (b.usageCount || 0) - (a.usageCount || 0);
                }
                case "recentlyUsed": {
                    return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
                }
                default: {
                    return b._creationTime - a._creationTime;
                }
            }
        });

        return filteredPrompts;
    });

/**
 * Get all prompts for the current user
 * Uses ActionCache for efficient caching (30 second TTL - prompts change frequently)
 */
export const getPrompts = authAction
    .use(rateLimit("library/read"))
    .input({
        favoriteOnly: v.optional(v.boolean()),
        sortBy: v.optional(v.union(v.literal("recent"), v.literal("mostUsed"), v.literal("recentlyUsed"), v.literal("alphabetical"))),
    })
    .action(async ({ args: { favoriteOnly, sortBy = "recent" }, ctx }): Promise<Doc<"prompts">[]> => {
        const { userId } = ctx.user;

        // Handle anonymous users - return empty array if no userId
        if (!userId) {
            return [];
        }

        const organizationId = ctx.user.activeOrganization?.id;

        const cache = new ActionCache<
            { favoriteOnly: boolean | null; organizationId: string | null; sortBy?: "alphabetical" | "mostUsed" | "recent" | "recentlyUsed"; userId: string },
            Doc<"prompts">[]
        >(undefined, {
            action: internal.prompts.functions.calculatePrompts,
            name: "prompts",
            ttl: 30 * 1000, // 30 seconds - prompts change frequently
        });

        const prompts = await cache.fetch(ctx, {
            favoriteOnly: favoriteOnly ?? null,
            organizationId: organizationId ?? null,
            sortBy,
            userId,
        });

        ctx.log.event("prompts.list", { count: prompts.length, favoriteOnly: favoriteOnly ?? false, sortBy });

        return prompts;
    });

/**
 * Get a single prompt by ID
 */
export const getPrompt = authQuery
    .input({
        promptId: v.id("prompts"),
    })
    .query(async ({ args: { promptId }, ctx }): Promise<Doc<"prompts"> | null> => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        const prompt = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!prompt) {
            return null;
        }

        // Check access - user owns it or it belongs to their organization
        const hasAccess = prompt.userId === userId || (organizationId && prompt.organizationId === organizationId);

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to view this prompt");
        }

        return prompt;
    });

/**
 * Create a new prompt
 */
export const createPrompt = authMutation
    .use(rateLimit("prompts/create"))
    .input({
        content: v.string().max(MAX_LENGTH.document),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        enabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        isFavorite: v.optional(v.boolean()),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        name: v.string().max(MAX_LENGTH.short),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        reasoningEffort: v.optional(v.number()),
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
    })
    .output(v.id("prompts"))
    .mutation(async ({ args: { content, description, enabledFeatures, isFavorite, model, name, organizationId, reasoningEffort, tags, variables }, ctx }) => {
        const { userId } = ctx.user;

        assertOwnOrganizationId(ctx.user, organizationId);

        // After `assertOwnOrganizationId`, a truthy `organizationId` already equals the caller's active
        // organization, so the identity alone is the value — the write never takes it from `args`.
        const organizationIdToUse = ctx.user.activeOrganization?.id;
        const now = ctx.now;

        await assertPromptQuota(ctx);

        const promptId = await ctx.db.insert("prompts", {
            content,
            currentVersion: 1,
            description,
            enabledFeatures,
            isFavorite: isFavorite ?? false,
            model,
            name,
            organizationId: organizationIdToUse,
            reasoningEffort,
            tags,
            updatedAt: now,
            userId,
            variables,
        });

        // Invalidate tags cache since tags may have changed
        await invalidatePromptTagsCache(ctx, userId, organizationIdToUse);
        // Invalidate prompts list cache
        await invalidatePromptsCache(ctx, userId, organizationIdToUse);

        // Create initial history entry
        await ctx.db.insert("promptHistory", {
            changeType: "created",
            content,
            createdAt: now,
            description,
            enabledFeatures,
            model,
            note: "Initial version",
            promptId,
            reasoningEffort,
            tags,
            userId,
            variables,
            version: 1,
        });

        ctx.log.event("prompts.create", { promptId, tagCount: tags?.length ?? 0, variableCount: variables?.length ?? 0 });

        return promptId;
    });

/**
 * Update an existing prompt
 */
export const updatePrompt = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        changeType: v.optional(v.union(v.literal("manual"), v.literal("optimized"), v.literal("restored"))),
        content: v.optional(v.string().max(MAX_LENGTH.document)),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        enabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        isFavorite: v.optional(v.boolean()),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        note: v.optional(v.string().max(MAX_LENGTH.long)),
        promptId: v.id("prompts"),
        reasoningEffort: v.optional(v.number()),
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
    })
    .output(v.id("prompts"))
    .mutation(
        async ({
            args: { changeType, content, description, enabledFeatures, isFavorite, model, name, note, promptId, reasoningEffort, tags, variables },
            ctx,
        }) => {
            const { userId } = ctx.user;
            const organizationId = ctx.user.activeOrganization?.id;
            const now = ctx.now;

            const existing = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

            if (!existing) {
                throw new LunoraError("NOT_FOUND", "Prompt not found");
            }

            // Check ownership - user owns it or it belongs to their organization
            const hasAccess = existing.userId === userId || (organizationId && existing.organizationId === organizationId);

            if (!hasAccess) {
                throw new LunoraError("FORBIDDEN", "Not authorized to update this prompt");
            }

            // Only save history if content, variables, or settings are changing
            const isContentChanged = content !== undefined && content !== existing.content;
            const isVariablesChanged = variables !== undefined && JSON.stringify(variables) !== JSON.stringify(existing.variables);
            const isModelChanged = model !== undefined && model !== existing.model;
            const isReasoningEffortChanged = reasoningEffort !== undefined && reasoningEffort !== existing.reasoningEffort;
            const isEnabledFeaturesChanged = enabledFeatures !== undefined && JSON.stringify(enabledFeatures) !== JSON.stringify(existing.enabledFeatures);
            const shouldSaveHistory = isContentChanged || isVariablesChanged || isModelChanged || isReasoningEffortChanged || isEnabledFeaturesChanged;
            const newVersion = (existing.currentVersion || 1) + (shouldSaveHistory ? 1 : 0);

            // Save history entry if content, variables, or settings changed
            if (shouldSaveHistory) {
                await ctx.db.insert("promptHistory", {
                    changeType: changeType || "manual",
                    content: content === undefined ? existing.content : content,
                    createdAt: now,
                    description: description === undefined ? existing.description : description,
                    enabledFeatures: enabledFeatures === undefined ? existing.enabledFeatures : enabledFeatures,
                    model: model === undefined ? existing.model : model,
                    note,
                    promptId,
                    reasoningEffort: reasoningEffort === undefined ? existing.reasoningEffort : reasoningEffort,
                    tags: tags === undefined ? existing.tags : tags,
                    userId,
                    variables: variables === undefined ? existing.variables : variables,
                    version: newVersion,
                });
            }

            await ctx.db.patch(promptId, {
                ...(content !== undefined && { content }),
                ...(shouldSaveHistory && { currentVersion: newVersion }),
                ...(description !== undefined && { description }),
                ...(enabledFeatures !== undefined && { enabledFeatures }),
                ...(isFavorite !== undefined && { isFavorite }),
                ...(model !== undefined && { model }),
                ...(name !== undefined && { name }),
                ...(reasoningEffort !== undefined && { reasoningEffort }),
                ...(tags !== undefined && { tags }),
                ...(variables !== undefined && { variables }),
                updatedAt: now,
            });

            // Invalidate tags cache if tags changed
            if (tags !== undefined) {
                await invalidatePromptTagsCache(ctx, userId, organizationId);
            }

            // Invalidate prompts list cache (prompt was updated)
            await invalidatePromptsCache(ctx, userId, organizationId);

            ctx.log.event("prompts.update", { changeType: changeType ?? null, promptId, tagsChanged: tags !== undefined });

            return promptId;
        },
    );

/**
 * Delete a prompt
 */
export const deletePrompt = authMutation
    .use(rateLimit("prompts/delete"))
    .input({
        promptId: v.id("prompts"),
    })
    .mutation(async ({ args: { promptId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        const existing = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "Prompt not found");
        }

        // Check ownership - user owns it or it belongs to their organization
        const hasAccess = existing.userId === userId || (organizationId && existing.organizationId === organizationId);

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to delete this prompt");
        }

        // Invalidate tags cache since a prompt was deleted
        await invalidatePromptTagsCache(ctx, userId, organizationId);
        // Invalidate prompts list cache
        await invalidatePromptsCache(ctx, userId, organizationId);

        await ctx.db.delete(promptId);

        ctx.log.event("prompts.delete", { promptId });
    });

/**
 * Record that a prompt was used
 */
export const recordPromptUsage = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        promptId: v.id("prompts"),
    })
    .mutation(async ({ args: { promptId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;
        const now = ctx.now;

        const existing = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!existing) {
            // Silently fail - prompt might have been deleted
            return;
        }

        // Check access - user owns it or it belongs to their organization
        const hasAccess = existing.userId === userId || (organizationId && existing.organizationId === organizationId);

        if (!hasAccess) {
            // Silently fail - user might not have access anymore
            return;
        }

        await ctx.db.patch(promptId, {
            lastUsedAt: now,
            usageCount: (existing.usageCount || 0) + 1,
        });

        ctx.log.event("prompts.record_usage", { promptId });
    });

/**
 * Toggle favorite status for a prompt
 */
export const togglePromptFavorite = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        promptId: v.id("prompts"),
    })
    .output(v.boolean())
    .mutation(async ({ args: { promptId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        const existing = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "Prompt not found");
        }

        // Check ownership - user owns it or it belongs to their organization
        const hasAccess = existing.userId === userId || (organizationId && existing.organizationId === organizationId);

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to update this prompt");
        }

        await ctx.db.patch(promptId, {
            isFavorite: !existing.isFavorite,
            updatedAt: ctx.now,
        });

        ctx.log.event("prompts.toggle_favorite", { isFavorite: !existing.isFavorite, promptId });

        return !existing.isFavorite;
    });

/**
 * Search prompts by name
 */
export const searchPrompts = authQuery
    .input({
        query: v.string().max(MAX_LENGTH.long),
        tags: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    })
    .query(async ({ args: { query, tags }, ctx }): Promise<Doc<"prompts">[]> => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        // If no query, get all prompts (limited to prevent timeout)
        const MAX_PROMPTS = 200;

        if (!query.trim() && (!tags || tags.length === 0)) {
            const { page: userPrompts } = await ctx.db.prompts.findMany({ limit: MAX_PROMPTS, orderBy: PROMPTS_BY_FAVORITE_DESC, where: { userId } });

            let orgPrompts: Doc<"prompts">[] = [];

            if (organizationId) {
                orgPrompts = await ctx.db.prompts
                    .findMany({ limit: MAX_PROMPTS, orderBy: PROMPTS_BY_FAVORITE_DESC, where: { organizationId } })
                    .then((result) => result.page);
            }

            // Combine and deduplicate
            const allPrompts = [...userPrompts, ...orgPrompts];

            return allPrompts.filter((prompt, index, self) => index === self.findIndex((p) => p._id === prompt._id));
        }

        // Limit search results to prevent timeout
        const MAX_SEARCH_RESULTS = 50;

        // Search by name
        const nameResults = query.trim()
            ? await ctx.db.prompts.withSearchIndex("search_prompts", (q) => q.search("name", query).eq("userId", userId)).take(MAX_SEARCH_RESULTS)
            : [];

        // Search by content
        const contentResults = query.trim()
            ? await ctx.db.prompts.withSearchIndex("search_prompt_body", (q) => q.search("content", query).eq("userId", userId)).take(MAX_SEARCH_RESULTS)
            : [];

        // Combine and deduplicate search results
        const combinedResults = [...nameResults, ...contentResults];
        let uniqueResults = combinedResults.filter((prompt, index, self) => index === self.findIndex((p) => p._id === prompt._id));

        // If no query but has tags, get all prompts first (limited to prevent timeout)
        const MAX_PROMPTS_FOR_TAG_FILTER = 200;

        if (!query.trim() && tags && tags.length > 0) {
            const { page: userPrompts } = await ctx.db.prompts.findMany({
                limit: MAX_PROMPTS_FOR_TAG_FILTER,
                orderBy: PROMPTS_BY_FAVORITE_DESC,
                where: { userId },
            });

            let orgPrompts: Doc<"prompts">[] = [];

            if (organizationId) {
                orgPrompts = await ctx.db.prompts
                    .findMany({ limit: MAX_PROMPTS_FOR_TAG_FILTER, orderBy: PROMPTS_BY_FAVORITE_DESC, where: { organizationId } })
                    .then((result) => result.page);
            }

            // Combine and deduplicate
            const allPrompts = [...userPrompts, ...orgPrompts];

            uniqueResults = allPrompts.filter((prompt, index, self) => index === self.findIndex((p) => p._id === prompt._id));
        }

        // Filter by tags if provided
        if (tags && tags.length > 0) {
            uniqueResults = uniqueResults.filter((prompt) => {
                if (!prompt.tags || prompt.tags.length === 0) {
                    return false;
                }

                // Check if prompt has any of the specified tags
                return tags.some((tag) => prompt.tags?.includes(tag));
            });
        }

        return uniqueResults;
    });

/**
 * Get all unique tags used across prompts
 * Uses ActionCache for efficient caching (5 minute TTL)
 * This is an action (not a query) to enable action-cache functionality
 */
export const getPromptTags = authAction
    .use(rateLimit("library/read"))
    .output(v.array(v.string()))
    .action(async ({ ctx }): Promise<string[]> => {
        const { userId } = ctx.user;

        if (!userId) {
            return [];
        }

        const organizationId = ctx.user.activeOrganization?.id;
        // Use ActionCache to fetch tags (will calculate if cache miss)
        // `string[]`, not `Doc<"prompts">[]` — `calculatePromptTags` returns TAGS.
        const cache = new ActionCache<{ organizationId: string | null; userId: string }, string[]>(undefined, {
            action: internal.prompts.functions.calculatePromptTags,
            name: "promptTags",
            ttl: 5 * 60 * 1000, // 5 minutes
        });

        const tags = await cache.fetch(ctx, {
            organizationId: organizationId ?? null,
            userId,
        });

        ctx.log.event("prompts.list_tags", { count: tags.length });

        return tags;
    });

export const getPromptsByUserInternal = internalQuery
    .input({
        maxPrompts: v.number(),
        userId: v.string(),
    })
    .query(
        async ({ args: { maxPrompts, userId }, ctx: context }) =>
            await context.db.prompts.findMany({ limit: maxPrompts, orderBy: PROMPTS_BY_FAVORITE_DESC, where: { userId } }).then((result) => result.page),
    );

export const getPromptsByOrganizationInternal = internalQuery
    .input({
        maxPrompts: v.number(),
        organizationId: v.string(),
    })
    .query(
        async ({ args: { maxPrompts, organizationId }, ctx: context }) =>
            await context.db.prompts
                .findMany({ limit: maxPrompts, orderBy: PROMPTS_BY_FAVORITE_DESC, where: { organizationId } })
                .then((result) => result.page),
    );

export const calculatePromptTags = internalAction
    .input({
        organizationId: v.optional(v.union(v.string(), v.null())),
        userId: v.string(),
    })
    .output(v.array(v.string()))
    .action(async ({ args: { organizationId, userId }, ctx: context }) => {
        const MAX_PROMPTS_FOR_TAGS = 500;

        const userPrompts = await context.runQuery(internal.prompts.functions.getPromptsByUserInternal, {
            maxPrompts: MAX_PROMPTS_FOR_TAGS,
            userId,
        });

        let orgPrompts: Doc<"prompts">[] = [];

        if (organizationId) {
            orgPrompts = await context.runQuery(internal.prompts.functions.getPromptsByOrganizationInternal, {
                maxPrompts: MAX_PROMPTS_FOR_TAGS,
                organizationId,
            });
        }

        // Combine and get unique tags
        const allPrompts = [...userPrompts, ...orgPrompts];
        const tagSet = new Set<string>();

        for (const prompt of allPrompts) {
            if (prompt.tags) {
                for (const tag of prompt.tags) {
                    tagSet.add(tag);
                }
            }
        }

        return [...tagSet].toSorted(compareStrings);
    });

export const getPromptCountInternal = internalQuery
    .input({
        userId: v.string(),
    })
    .query(async ({ args: { userId }, ctx: context }) => await context.db.prompts.count({ userId }));

export const calculatePromptCount = internalAction
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
        const count = await context.runQuery(internal.prompts.functions.getPromptCountInternal, {
            userId,
        });

        const limit = isPremium ? null : FREE_PROMPT_LIMIT;
        const canCreate = isPremium || count < FREE_PROMPT_LIMIT;

        return {
            canCreate,
            count,
            isPremium,
            limit,
        };
    });

/**
 * Get prompt count and limit information for the current user
 * Uses ActionCache for efficient caching (30 second TTL)
 */
export const getPromptCount = authAction
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
                limit: FREE_PROMPT_LIMIT,
            };
        }

        const isPremium = ctx.user.plan === "premium" || ctx.user.isAdmin;

        // Use ActionCache for efficient caching (30 second TTL - count changes frequently)
        // The result type is the COUNT payload, not a row array. `Doc<"prompts">[]`
        // here (and on `promptTags` above) came out of the port and made both
        // `cache.fetch` results unassignable to the outputs their functions declare.
        const cache = new ActionCache<{ isPremium: boolean; userId: string }, { canCreate: boolean; count: number; isPremium: boolean; limit: null | number }>(
            undefined,
            {
                action: internal.prompts.functions.calculatePromptCount,
                name: "promptCount",
                ttl: 30 * 1000, // 30 seconds
            },
        );

        const counts = await cache.fetch(ctx, { isPremium, userId });

        ctx.log.event("prompts.count", { canCreate: counts.canCreate, count: counts.count, isPremium });

        return counts;
    });

/**
 * Get history for a prompt
 */
export const getPromptHistory = authQuery
    .input({
        promptId: v.id("prompts"),
    })
    .query(async ({ args: { promptId }, ctx }): Promise<Doc<"promptHistory">[]> => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        // Verify access to the prompt
        const prompt = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!prompt) {
            throw new LunoraError("NOT_FOUND", "Prompt not found");
        }

        const hasAccess = prompt.userId === userId || (organizationId && prompt.organizationId === organizationId);

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to view this prompt's history");
        }

        // Get history entries for this prompt, sorted by version (newest first)
        const MAX_HISTORY_ENTRIES = 500;
        const { page: history } = await ctx.db.promptHistory.findMany({
            limit: MAX_HISTORY_ENTRIES,
            orderBy: [{ version: "asc" }, { _creationTime: "asc" }],
            where: { promptId },
        });

        // Sort by version descending (newest first)
        history.sort((a, b) => b.version - a.version);

        return history;
    });

/**
 * Restore a prompt to a previous version
 */
export const restorePromptVersion = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        promptId: v.id("prompts"),
        version: v.number(),
    })
    .output(v.id("prompts"))
    .mutation(async ({ args: { promptId, version }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;
        const now = ctx.now;

        // Get the prompt
        const prompt = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!prompt) {
            throw new LunoraError("NOT_FOUND", "Prompt not found");
        }

        const hasAccess = prompt.userId === userId || (organizationId && prompt.organizationId === organizationId);

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to restore this prompt");
        }

        // Find the history entry for the specified version
        // Limit to 10 entries per prompt/version combination (should be unique anyway)
        const historyEntry = await ctx.db.promptHistory.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { promptId, version } });

        if (!historyEntry) {
            throw new LunoraError("NOT_FOUND", `Version ${version} not found for this prompt`);
        }

        // Create a new version with the restored content
        const newVersion = (prompt.currentVersion || 1) + 1;

        // Save history entry for the restore action
        await ctx.db.insert("promptHistory", {
            changeType: "restored",
            content: historyEntry.content,
            createdAt: now,
            description: historyEntry.description,
            note: `Restored from version ${version}`,
            promptId,
            tags: historyEntry.tags,
            userId,
            variables: historyEntry.variables,
            version: newVersion,
        });

        // Update the prompt with the restored content. A field the restored
        // version did not have is removed, not kept from the current one.
        await patchRow(ctx.db, prompt, {
            content: historyEntry.content,
            currentVersion: newVersion,
            description: historyEntry.description,
            tags: historyEntry.tags,
            updatedAt: now,
            variables: historyEntry.variables,
        });

        ctx.log.event("prompts.restore_version", { newVersion, promptId, restoredVersion: version });

        return promptId;
    });

/**
 * Duplicate a prompt
 */
export const duplicatePrompt = authMutation
    .use(rateLimit("prompts/create"))
    .input({
        promptId: v.id("prompts"),
    })
    .output(v.id("prompts"))
    .mutation(async ({ args: { promptId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;
        const now = ctx.now;

        const existing = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "Prompt not found");
        }

        // Check access - user owns it or it belongs to their organization
        const hasAccess = existing.userId === userId || (organizationId && existing.organizationId === organizationId);

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to duplicate this prompt");
        }

        // A copy is a new prompt: same quota as `createPrompt`.
        await assertPromptQuota(ctx);

        const newPromptId = await ctx.db.insert("prompts", {
            content: existing.content,
            currentVersion: 1,
            description: existing.description,
            isFavorite: false,
            name: `${existing.name} (Copy)`,
            organizationId: existing.organizationId,
            tags: existing.tags,
            updatedAt: now,
            userId,
            variables: existing.variables,
        });

        // Create initial history entry for the duplicate
        await ctx.db.insert("promptHistory", {
            changeType: "created",
            content: existing.content,
            createdAt: now,
            description: existing.description,
            note: `Duplicated from "${existing.name}"`,
            promptId: newPromptId,
            tags: existing.tags,
            userId,
            variables: existing.variables,
            version: 1,
        });

        ctx.log.event("prompts.duplicate", { newPromptId, promptId });

        return newPromptId;
    });

// ============================================
// Thread Variables Functions
// ============================================

/*
 * A `threadVariables` row is created for the thread named in args, and the
 * FIRST row per thread wins (`by_thread` + `.first()`): without
 * `requireOwnedThread`, a stranger could plant variables in someone's thread —
 * substituted into their prompts — and lock the owner out of their own.
 */

/**
 * Get variables for a specific thread
 */
export const getThreadVariables = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(async ({ args: { threadId }, ctx }) => {
        const { userId } = ctx.user;

        const threadVariables = await ctx.db
            .query("threadVariables")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (!threadVariables) {
            return { threadId, userId, variables: [] };
        }

        // Verify ownership
        if (threadVariables.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not authorized to view these variables");
        }

        return threadVariables;
    });

/**
 * Set/update variables for a specific thread
 */
export const setThreadVariables = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        threadId: v.id("threads"),
        variables: v.array(v.object({ name: v.string().max(MAX_LENGTH.short), value: v.string().max(MAX_LENGTH.document) })),
    })
    .output(v.string())
    .mutation(async ({ args: { threadId, variables }, ctx }) => {
        const { userId } = ctx.user;
        const now = ctx.now;

        // Check if thread variables already exist
        const existing = await ctx.db
            .query("threadVariables")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (existing) {
            // Verify ownership
            if (existing.userId !== userId) {
                throw new LunoraError("FORBIDDEN", "Not authorized to update these variables");
            }

            // Update existing
            await ctx.db.patch(existing._id, {
                updatedAt: now,
                variables,
            });

            ctx.log.event("prompts.set_thread_variables", { created: false, threadId, variableCount: variables.length });

            return existing._id;
        }

        await requireOwnedThread(ctx, threadId, userId);

        // Create new
        const id = await ctx.db.insert("threadVariables", {
            threadId,
            updatedAt: now,
            userId,
            variables,
        });

        ctx.log.event("prompts.set_thread_variables", { created: true, threadId, variableCount: variables.length });

        return id;
    });

/**
 * Update a single variable for a thread
 */
export const updateThreadVariable = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        name: v.string().max(MAX_LENGTH.short),
        threadId: v.id("threads"),
        value: v.string().max(MAX_LENGTH.document),
    })
    .output(v.string())
    .mutation(async ({ args: { name, threadId, value }, ctx }) => {
        const { userId } = ctx.user;
        const now = ctx.now;

        // Check if thread variables already exist
        const existing = await ctx.db
            .query("threadVariables")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (existing) {
            // Verify ownership
            if (existing.userId !== userId) {
                throw new LunoraError("FORBIDDEN", "Not authorized to update these variables");
            }

            // Update or add the variable
            const variables = [...existing.variables];
            const existingIndex = variables.findIndex((vector) => vector.name === name);

            if (existingIndex === -1) {
                variables.push({ name, value });
            } else {
                variables[existingIndex] = { name, value };
            }

            await ctx.db.patch(existing._id, {
                updatedAt: now,
                variables,
            });

            ctx.log.event("prompts.update_thread_variable", { created: false, threadId });

            return existing._id;
        }

        await requireOwnedThread(ctx, threadId, userId);

        // Create new with single variable
        const id = await ctx.db.insert("threadVariables", {
            threadId,
            updatedAt: now,
            userId,
            variables: [{ name, value }],
        });

        ctx.log.event("prompts.update_thread_variable", { created: true, threadId });

        return id;
    });

/**
 * Delete a variable from a thread
 */
export const deleteThreadVariable = authMutation
    .use(rateLimit("prompts/delete"))
    .input({
        name: v.string().max(MAX_LENGTH.short),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { name, threadId }, ctx }) => {
        const { userId } = ctx.user;
        const now = ctx.now;

        const existing = await ctx.db
            .query("threadVariables")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (!existing) {
            return; // Nothing to delete
        }

        // Verify ownership
        if (existing.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not authorized to delete these variables");
        }

        // Remove the variable
        const variables = existing.variables.filter((innerV: { name: string }) => innerV.name !== name);

        if (variables.length === 0) {
            // Delete the entire record if no variables left
            await ctx.db.delete(existing._id);
        } else {
            await ctx.db.patch(existing._id, {
                updatedAt: now,
                variables,
            });
        }

        ctx.log.event("prompts.delete_thread_variable", { remainingCount: variables.length, threadId });
    });

/**
 * Apply thread variables to prompt content
 * Returns the prompt with variables replaced by their values
 */
export const applyThreadVariablesToPrompt = authQuery
    .input({
        promptId: v.id("prompts"),
        threadId: v.id("threads"),
    })
    .output(
        // `prompt: v.any()`, not `v.record(v.string(), v.any())`. The handler returns
        // the `prompts` row, and a generated `Doc_*` is an INTERFACE — no index
        // signature, so it satisfies no `Record<string, …>`. `v.record` here was
        // describing "an object" and getting "a type nothing can be assigned to".
        v.object({ appliedContent: v.string(), originalContent: v.string(), prompt: v.any(), variables: v.record(v.string(), v.string()) }),
    )
    .query(async ({ args: { promptId, threadId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        // Get the prompt
        const prompt = await ctx.db.prompts.findFirst({ where: { _id: promptId as Id<"prompts"> } });

        if (!prompt) {
            throw new LunoraError("NOT_FOUND", "Prompt not found");
        }

        // Check access
        const hasPromptAccess = prompt.userId === userId || (organizationId && prompt.organizationId === organizationId);

        if (!hasPromptAccess) {
            throw new LunoraError("FORBIDDEN", "Not authorized to view this prompt");
        }

        // Get thread variables
        const threadVariables = await ctx.db
            .query("threadVariables")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        // Build values map from thread variables
        const values: Record<string, string> = {};

        // Only the caller's own row: `threadId` is an arg, and another user's
        // thread variables are theirs.
        if (threadVariables && threadVariables.userId === userId) {
            for (const variable of threadVariables.variables) {
                values[variable.name] = variable.value;
            }
        }

        // Also apply default values from prompt definition for any missing variables
        if (prompt.variables) {
            for (const variable of prompt.variables) {
                if (!Object.hasOwn(values, variable.name) && variable.defaultValue) {
                    values[variable.name] = variable.defaultValue;
                }
            }
        }

        // Replace variables in content
        const appliedContent = prompt.content.replace(
            VARIABLE_REGEX,
            (match, variableName: string) =>
                // `?? match` rather than an `in` check: a `values` entry could be
                // present-but-undefined, and the replacer must return a string. This is
                // the same "keep the placeholder" behaviour, just without the hole.
                // Keeps the placeholder when the variable has no value.
                values[variableName] ?? match,
        );

        return {
            appliedContent,
            originalContent: prompt.content,
            prompt,
            variables: values,
        };
    });

// ============================================
// User Default Variables Functions
// ============================================

/**
 * Get user's default variable values
 */
export const getUserVariableDefaults = authQuery
    .input({})
    .output(v.object({ organizationId: v.optional(v.string()), userId: v.string(), variables: v.array(v.object({ name: v.string(), value: v.string() })) }))
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        // Get user defaults
        const userDefaults = await ctx.db.userVariableDefaults.findFirst({ orderBy: USER_DEFAULTS_INDEX_ORDER, where: { userId } });

        // Get organization defaults if applicable
        const orgDefaults = organizationId
            ? await ctx.db.userVariableDefaults.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { organizationId } })
            : null;

        // Merge: user defaults override org defaults
        const mergedVariables: { name: string; value: string }[] = [];
        const seen = new Set<string>();

        // Add user defaults first (higher priority)
        if (userDefaults?.variables) {
            for (const innerV of userDefaults.variables) {
                mergedVariables.push(innerV);
                seen.add(innerV.name);
            }
        }

        // Add org defaults for any missing variables
        if (orgDefaults?.variables) {
            for (const innerV of orgDefaults.variables) {
                if (!seen.has(innerV.name)) {
                    mergedVariables.push(innerV);
                }
            }
        }

        return {
            organizationId,
            userId,
            variables: mergedVariables,
        };
    });

/**
 * Set user's default variable values
 */
export const setUserVariableDefaults = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        variables: v.array(v.object({ name: v.string().max(MAX_LENGTH.short), value: v.string().max(MAX_LENGTH.document) })),
    })
    .output(v.string())
    .mutation(async ({ args: { variables }, ctx }) => {
        const { userId } = ctx.user;
        const now = ctx.now;

        // Check if defaults already exist for this user
        const existing = await ctx.db.userVariableDefaults.findFirst({ orderBy: USER_DEFAULTS_INDEX_ORDER, where: { userId } });

        if (existing) {
            await ctx.db.patch(existing._id, {
                updatedAt: now,
                variables,
            });

            ctx.log.event("prompts.set_user_variable_defaults", { created: false, variableCount: variables.length });

            return existing._id;
        }

        // Create new
        const id = await ctx.db.insert("userVariableDefaults", {
            updatedAt: now,
            userId,
            variables,
        });

        ctx.log.event("prompts.set_user_variable_defaults", { created: true, variableCount: variables.length });

        return id;
    });

/**
 * Set organization default variable values (admin only)
 */
export const setOrganizationVariableDefaults = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        variables: v.array(v.object({ name: v.string().max(MAX_LENGTH.short), value: v.string().max(MAX_LENGTH.document) })),
    })
    .output(v.string())
    .mutation(async ({ args: { variables }, ctx }) => {
        const { userId } = ctx.user;

        if (!ctx.user?.activeOrganization) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        const organizationId = ctx.user.activeOrganization.id;
        const now = ctx.now;

        const memberRole = ctx.user.activeOrganization.role;

        if (memberRole !== "owner" && memberRole !== "admin") {
            throw new LunoraError("FORBIDDEN", "Only organization admins can set organization variable defaults");
        }

        if (!organizationId) {
            throw new LunoraError("BAD_REQUEST", "No organization selected");
        }

        // Check if defaults already exist for this organization
        const existing = await ctx.db.userVariableDefaults.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { organizationId } });

        if (existing) {
            await ctx.db.patch(existing._id, {
                updatedAt: now,
                variables,
            });

            ctx.log.event("prompts.set_organization_variable_defaults", { created: false, organizationId, variableCount: variables.length });

            return existing._id;
        }

        // Create new
        const id = await ctx.db.insert("userVariableDefaults", {
            organizationId,
            updatedAt: now,
            userId,
            variables,
        });

        ctx.log.event("prompts.set_organization_variable_defaults", { created: true, organizationId, variableCount: variables.length });

        return id;
    });

/**
 * Get all variable values for a thread (merges user defaults + thread overrides)
 */
export const getResolvedVariables = authQuery
    .input({
        threadId: v.optional(v.id("threads")),
    })
    .output(
        v.object({
            sources: v.record(v.string(), v.union(v.literal("organization"), v.literal("user"), v.literal("thread"))),
            values: v.record(v.string(), v.string()),
        }),
    )
    .query(async ({ args: { threadId }, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        const values: Record<string, string> = {};
        const sources: Record<string, "organization" | "user" | "thread"> = {};

        // Run all 3 independent queries in parallel
        const [orgDefaults, userDefaults, threadVariables] = await Promise.all([
            // 1. Organization defaults (lowest priority)
            organizationId ? ctx.db.userVariableDefaults.findFirst({ orderBy: [{ _creationTime: "asc" }], where: { organizationId } }) : Promise.resolve(null),
            // 2. User defaults (medium priority)
            ctx.db.userVariableDefaults.findFirst({ orderBy: USER_DEFAULTS_INDEX_ORDER, where: { userId } }),
            // 3. Thread overrides (highest priority)
            threadId
                ? ctx.db
                      .query("threadVariables")
                      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
                      .first()
                : Promise.resolve(null),
        ]);

        // Apply in priority order: org (lowest) -> user -> thread (highest)
        if (orgDefaults?.variables) {
            for (const innerV of orgDefaults.variables) {
                values[innerV.name] = innerV.value;
                sources[innerV.name] = "organization";
            }
        }

        if (userDefaults?.variables) {
            for (const innerV of userDefaults.variables) {
                values[innerV.name] = innerV.value;
                sources[innerV.name] = "user";
            }
        }

        // Only the caller's own row — `threadId` is an arg (see `applyThreadVariablesToPrompt`).
        if (threadVariables?.variables && threadVariables.userId === userId) {
            for (const innerV of threadVariables.variables) {
                values[innerV.name] = innerV.value;
                sources[innerV.name] = "thread";
            }
        }

        return { sources, values };
    });

// ============================================
// AI Functions
// ============================================

export const optimizePrompt = internalAction
    .input({
        content: v.string(),
        improvementInstructions: v.optional(v.string()),
        /**
         * The caller, resolved by the HTTP route (`prompts/http.ts`). It used to be
         * read here from `identity.subject` — which `resolveIdentity` never sets,
         * so every call answered "must be logged in".
         */
        userId: v.string(),
    })
    .action(async ({ args: { content, improvementInstructions, userId }, ctx: context }) => {
        if (!userId) {
            throwUnauthorized("User must be logged in");
        }

        if (!content.trim()) {
            throwBadRequest("Prompt content cannot be empty");
        }

        if (content.trim().length > 10_000) {
            throwBadRequest("Prompt is too long. Please keep it under 10,000 characters.");
        }

        // Check rate limits
        // Note: In internalAction, we don't have context.user, so we use "free" tier
        // The user is already authenticated via context.auth.getUserIdentity()
        const tier = "free" as const;
        const rateLimitKey = getRateLimitKey("chat/promptImprovement", tier);
        const rateLimitResult = await checkRateLimit(context, rateLimitKey, {
            count: 1,
            key: userId,
        });

        if (!rateLimitResult.ok) {
            const retryAfterSeconds = Math.ceil((rateLimitResult.retryAfter || 60_000) / 1000);

            throw new LunoraError("TOO_MANY_REQUESTS", `Rate limit exceeded. Please try again in ${retryAfterSeconds} seconds.`, {
                data: {
                    kind: "RateLimitError",
                    message: `Rate limit exceeded. Please try again in ${retryAfterSeconds} seconds.`,
                    name: rateLimitKey,
                    retryAfter: rateLimitResult.retryAfter,
                },
            });
        }

        // Check global rate limit as well
        const globalRateLimitResult = await checkRateLimit(context, "chat/globalPromptImprovement", {
            count: 1,
            key: "global",
        });

        if (!globalRateLimitResult.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", "System is currently busy. Please try again in a moment.", {
                data: {
                    kind: "RateLimitError",
                    message: "System is currently busy. Please try again in a moment.",
                    name: "chat/globalPromptImprovement",
                    retryAfter: globalRateLimitResult.retryAfter,
                },
            });
        }

        const model = DEFAULT_PROMPT_IMPROVEMENT_MODEL;

        const agent = await getAgent(model, { gateway: gatewayFetch(context) });

        // Create a temporary thread for optimization
        const { thread } = await agent.createThread(context, {
            title: "Prompt Optimization",
            userId,
        });

        // Build the system prompt with optional improvement instructions
        let systemPrompt = `You are an expert prompt engineer specializing in creating effective system prompts for AI assistants. Your task is to optimize the given prompt to make it more effective, clear, and likely to produce better AI responses.

Guidelines for optimization:
1. Make the prompt more specific and detailed
2. Add context where helpful
3. Structure the request clearly with clear instructions
4. Include examples if beneficial
5. Specify the desired format or style of response
6. Remove ambiguity and add clarity
7. Keep the core intent intact while enhancing effectiveness
8. Ensure the prompt is well-organized and easy to follow
9. Add role definition if appropriate (e.g., "You are a...")
10. Include constraints or boundaries where necessary

Return the optimized prompt in the optimizedPrompt field. The optimized prompt should be ready to use directly without any explanation or meta-commentary.

Original prompt to optimize:
"""
${content.trim()}
"""`;

        // Add specific improvement instructions if provided
        if (improvementInstructions?.trim()) {
            systemPrompt += `\n\nSpecific optimization instructions from the user: ${improvementInstructions.trim()}`;
        }

        const { object: optimizedPromptObject } = await thread.generateObject(
            {
                prompt: systemPrompt,
                schema: z.object({ optimizedPrompt: z.string() }).strict(),
            },
            {
                storageOptions: {
                    saveMessages: "none",
                },
            },
        );

        // Schedule cleanup of the temporary thread
        // Using scheduler to avoid blocking the response
        try {
            await context.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: thread.threadId as Id<"threads"> });
        } catch {
            // Silently handle errors - thread cleanup is best effort
            // The thread will be cleaned up by the normal cleanup processes
        }

        context.log.event("prompts.optimize", {
            inputChars: content.length,
            model,
            promptChars: optimizedPromptObject.optimizedPrompt.length,
        });

        return optimizedPromptObject;
    });
