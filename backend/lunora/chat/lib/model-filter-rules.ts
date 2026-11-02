import type { ModelFilterRules } from "@neore/ai/models";

import { LunoraError } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import type { ServiceFetch } from "../../lib/services";
import { getUtilityModel, NO_ALLOWED_UTILITY_MODEL_MESSAGE, NoAllowedUtilityModelError, withPaidPlanGrant } from "../../lib/utility-model";

export const MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE = "Your model settings could not be read; try again.";

/**
 * The user's model filters could not be read. Not "no rules": a background call that carried on would send content to
 * a model the user may have forbidden, so it skips (or, for a gate, asks) like a call whose rules allow no model.
 */
export class ModelFilterRulesUnavailableError extends NoAllowedUtilityModelError {
    constructor() {
        super();
        this.message = MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE;
        this.name = "ModelFilterRulesUnavailableError";
    }
}

const FAILED = Symbol("read failed");

/** A query's answer, or `FAILED` when it threw (or could not be sent). */
const settled = async <T>(read: () => Promise<T>): Promise<T | typeof FAILED> => {
    try {
        return await read();
    } catch {
        return FAILED;
    }
};

/**
 * The user's model filters (`{}` when they set none), for a run to read once and hand to both the gateway models
 * (`getAgent({ modelFilterRules })`, which is where `requireZDR` / `denyDataCollection` reach the provider routing)
 * and `resolveBackupModelId`. Every run path loads them here, so the chosen model and its backup are routed alike.
 * Background model calls (`getUtilityModel`) read them the same way, and the returned rules also carry whether the
 * user's plan opens paid-plan models, which `pickUtilityModelId` applies to its candidates.
 *
 * `planUserId` names whose plan opens paid-plan models when that is not the rules' owner: a collaborator's call on
 * the owner's thread runs under the owner's filters (privacy) but is paid for, and so graded, as the caller.
 *
 * Throws `ModelFilterRulesUnavailableError` when the read fails: that is not the same as "no rules". An unreadable
 * plan is just "free".
 */
export const loadModelFilterRules = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, planUserId: string = userId): Promise<ModelFilterRules> => {
    const [preferences, plan] = await Promise.all([
        settled(async () => await ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId })),
        settled(async () => await ctx.runQuery(internal.auth.functions.getUserRunPlanQuery, { userId: planUserId })),
    ]);

    if (preferences === FAILED || preferences?.readFailed === true) {
        throw new ModelFilterRulesUnavailableError();
    }

    return withPaidPlanGrant(preferences?.modelFilterRules ?? {}, plan !== FAILED && plan !== null && (plan.isAdmin || plan.plan === "premium"));
};

const intersect = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
    const left = a && a.length > 0 ? a : undefined;
    const right = b && b.length > 0 ? b : undefined;

    if (!left || !right) {
        return left ?? right;
    }

    const both = left.filter((entry) => right.includes(entry));

    // An empty allow-list reads as "no restriction", so two lists with nothing in common must stay non-empty and match nothing.
    return both.length > 0 ? both : [NOTHING_ALLOWED];
};

const NOTHING_ALLOWED = "\u0000none";

const union = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => (a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined);

/**
 * Rules a model must satisfy to serve two users at once: block lists join, allow lists intersect, and a ZDR or
 * data-collection requirement from either holds. The plan grant (a symbol key) is the first argument's: it is the
 * caller's, who pays.
 */
export const mergeModelFilterRules = (payer: ModelFilterRules, other: ModelFilterRules): ModelFilterRules => {
    const merged: ModelFilterRules = {
        ...payer,
        allowedModels: intersect(payer.allowedModels, other.allowedModels),
        allowedProviders: intersect(payer.allowedProviders, other.allowedProviders),
        allowedRegions: intersect(payer.allowedRegions, other.allowedRegions),
        blockedModels: union(payer.blockedModels, other.blockedModels),
        blockedProviders: union(payer.blockedProviders, other.blockedProviders),
        blockedRegions: union(payer.blockedRegions, other.blockedRegions),
        denyDataCollection: payer.denyDataCollection === true || other.denyDataCollection === true ? true : undefined,
        requireZDR: payer.requireZDR === true || other.requireZDR === true ? true : undefined,
    };

    for (const key of Object.keys(merged) as (keyof ModelFilterRules)[]) {
        if (merged[key] === undefined) {
            delete merged[key];
        }
    }

    return merged;
};

/**
 * The rules for a call that carries the thread owner's content AND the caller's own input: both users' filters
 * apply, so the model is one each of them allows. The caller's plan grades the paid-plan rule, as they pay. For the
 * owner's own call it is just their rules.
 */
export const loadSharedModelFilterRules = async (ctx: Pick<ActionCtx, "runQuery">, callerId: string, ownerId: string | undefined): Promise<ModelFilterRules> => {
    const caller = await loadModelFilterRules(ctx, callerId);

    if (!ownerId || ownerId === callerId) {
        return caller;
    }

    return mergeModelFilterRules(caller, await loadModelFilterRules(ctx, ownerId, callerId));
};

/**
 * A background model for a user-facing action. With `filterUserId` (the thread owner) the call carries the owner's
 * content and the caller's input, so BOTH users' filter rules apply (`loadSharedModelFilterRules`); `userId` is the
 * caller who is metered and whose plan applies. Reading the rules and resolving the model share one failure
 * boundary, so a refusal (no allowed model) or an unreadable rules read both reach the client as a BAD_REQUEST that
 * says why, rather than as an internal error.
 */
export const getUtilityModelForUser = async (
    ctx: Pick<ActionCtx, "runQuery">,
    gateway: ServiceFetch,
    context: { filterUserId?: string; threadId?: string; userId: string },
    preferred?: string,
): ReturnType<typeof getUtilityModel> => {
    try {
        const { filterUserId, ...who } = context;

        return await getUtilityModel(gateway, { ...who, rules: await loadSharedModelFilterRules(ctx, who.userId, filterUserId) }, preferred);
    } catch (error) {
        if (error instanceof ModelFilterRulesUnavailableError) {
            throw new LunoraError("BAD_REQUEST", MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
        }

        throw error instanceof NoAllowedUtilityModelError ? new LunoraError("BAD_REQUEST", NO_ALLOWED_UTILITY_MODEL_MESSAGE) : error;
    }
};
