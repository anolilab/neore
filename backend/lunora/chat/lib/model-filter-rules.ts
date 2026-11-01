import type { ModelFilterRules } from "@neore/ai/models";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { NoAllowedUtilityModelError, withPaidPlanGrant } from "../../lib/utility-model";

/**
 * The user's model filters could not be read. Not "no rules": a background call that carried on would send content to
 * a model the user may have forbidden, so it skips (or, for a gate, asks) like a call whose rules allow no model.
 */
export class ModelFilterRulesUnavailableError extends NoAllowedUtilityModelError {
    constructor() {
        super();
        this.message = "Your model filter rules could not be read";
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
