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
 * Throws `ModelFilterRulesUnavailableError` when the read fails: that is not the same as "no rules". An unreadable
 * plan is just "free".
 */
export const loadModelFilterRules = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<ModelFilterRules> => {
    const [preferences, plan] = await Promise.all([
        settled(async () => await ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId })),
        settled(async () => await ctx.runQuery(internal.auth.functions.getUserRunPlanQuery, { userId })),
    ]);

    if (preferences === FAILED || preferences?.readFailed === true) {
        throw new ModelFilterRulesUnavailableError();
    }

    return withPaidPlanGrant(preferences?.modelFilterRules ?? {}, plan !== FAILED && plan !== null && (plan.isAdmin || plan.plan === "premium"));
};

/**
 * A background model for a user-facing action, under the user's filter rules. Reading the rules and resolving the
 * model share one failure boundary, so a refusal (no allowed model) or an unreadable rules read both reach the
 * client as a BAD_REQUEST that says why, rather than as an internal error.
 */
export const getUtilityModelForUser = async (
    ctx: Pick<ActionCtx, "runQuery">,
    gateway: ServiceFetch,
    context: { threadId?: string; userId: string },
    preferred?: string,
): ReturnType<typeof getUtilityModel> => {
    try {
        return await getUtilityModel(gateway, { ...context, rules: await loadModelFilterRules(ctx, context.userId) }, preferred);
    } catch (error) {
        if (error instanceof ModelFilterRulesUnavailableError) {
            throw new LunoraError("BAD_REQUEST", MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
        }

        throw error instanceof NoAllowedUtilityModelError ? new LunoraError("BAD_REQUEST", NO_ALLOWED_UTILITY_MODEL_MESSAGE) : error;
    }
};
