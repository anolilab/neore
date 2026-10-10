import { internal } from "../_generated/internal";
import type { ActionCtx as ActionContext, MutationCtx as MutationContext } from "../_generated/server";
import { logger } from "../lib/logger";

/** The `ActionCache` family `skills_functions.getSkills` caches under. */
export const SKILLS_CACHE_NAME = "skills";

/**
 * The caller's skills-list cache generation. `getSkills` keys its cache on it, so
 * one bump invalidates every sort/category/organization combination at once —
 * `category` is free text, so those combinations cannot be enumerated.
 */
export const getSkillsCacheGeneration = async (context: ActionContext, userId: string): Promise<string> =>
    await context.runQuery(internal.lib.action_cache.getGeneration, { name: SKILLS_CACHE_NAME, now: Date.now(), scope: userId });

/**
 * Invalidate a user's cached skills list. Call whenever a skill they see is
 * created, updated, deleted, installed or toggled.
 *
 * A failed bump is logged, not thrown: the write it follows already succeeded,
 * and the entries it would have invalidated expire on their own 30-second TTL.
 */
export const invalidateSkillsCache = async (context: ActionContext | MutationContext, userId: string): Promise<void> => {
    try {
        await context.runMutation(internal.lib.action_cache.bumpGeneration, { name: SKILLS_CACHE_NAME, scope: userId });
    } catch (error) {
        logger.warn("skills cache: could not bump the generation", error);
    }
};
