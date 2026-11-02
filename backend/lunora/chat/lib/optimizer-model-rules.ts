import { MODEL_LOOKUP, type ModelFilterRules } from "@neore/ai/models";

import type { ActionCtx } from "../../_generated/server";
import { throwBadRequest } from "../../lib/error-helpers";
import { avoidsBlockedRegions } from "../../lib/utility-model";
import { backupFilterRejection } from "./backup-model";
import { loadSharedModelFilterRules, MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE, ModelFilterRulesUnavailableError } from "./model-filter-rules";

export const NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE = "None of the models your model settings allow can run this.";

/**
 * The user's model filters for a prompt rewrite on `modelId`, to hand to `getAgent({ modelFilterRules })`.
 * `ownerId` is the owner of the thread a rewrite continues, when that is not the caller: its messages go to the
 * model too, so both users' filters apply (`loadSharedModelFilterRules`).
 * Refuses (BAD_REQUEST) rather than carry on when the read fails — "no rules" would send the user's text to a model
 * they may have forbidden — and when the rules exclude `modelId`, the only model the rewrite can use. Region rules
 * are judged as the background models judge them (`avoidsBlockedRegions`): a model reachable in a blocked region is
 * refused even if another of its regions is allowed, so what is picked and where it is routed agree.
 */
export const loadOptimizerModelRules = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string,
    modelId: string,
    ownerId?: string,
): Promise<ModelFilterRules> => {
    let rules: ModelFilterRules;

    try {
        rules = await loadSharedModelFilterRules(ctx, userId, ownerId);
    } catch (error) {
        if (error instanceof ModelFilterRulesUnavailableError) {
            return throwBadRequest(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
        }

        throw error;
    }

    const definition = MODEL_LOOKUP.get(modelId);

    if (definition && (!avoidsBlockedRegions(definition, rules) || backupFilterRejection(definition, rules) !== null)) {
        return throwBadRequest(NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE);
    }

    return rules;
};

export { MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE } from "./model-filter-rules";
