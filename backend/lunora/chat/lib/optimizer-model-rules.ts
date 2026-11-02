import { MODEL_LOOKUP, type ModelFilterRules } from "@neore/ai/models";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { throwBadRequest } from "../../lib/error-helpers";
import { backupFilterRejection } from "./backup-model";

export const MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE = "Your model settings could not be read; try again.";
export const NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE = "None of the models your model settings allow can run this.";

/**
 * The user's model filters for a prompt rewrite on `modelId`, to hand to `getAgent({ modelFilterRules })`.
 * Refuses (BAD_REQUEST) rather than carry on when the read fails — "no rules" would send the user's text to a model
 * they may have forbidden — and when the rules exclude `modelId`, the only model the rewrite can use.
 */
export const loadOptimizerModelRules = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, modelId: string): Promise<ModelFilterRules> => {
    let preferences;

    try {
        preferences = await ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId });
    } catch {
        return throwBadRequest(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
    }

    if (preferences?.readFailed === true) {
        return throwBadRequest(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
    }

    const rules = preferences?.modelFilterRules ?? {};
    const definition = MODEL_LOOKUP.get(modelId);

    if (definition && backupFilterRejection(definition, rules) !== null) {
        return throwBadRequest(NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE);
    }

    return rules;
};
