import type { ModelFilterRules } from "@neore/ai/models";

import type { ActionCtx } from "../../_generated/server";
import { throwBadRequest } from "../../lib/error-helpers";
import { pickUtilityModelId } from "../../lib/utility-model";
import { loadSharedModelFilterRules, MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE, ModelFilterRulesUnavailableError } from "./model-filter-rules";

export const NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE = "None of the models your model settings allow can run this.";

/**
 * The model a prompt rewrite runs on and the user's model filters for it, to hand to `getAgent({ modelFilterRules })`.
 * `modelId` is a platform default; when the rules exclude it — the Workers AI defaults fail every region rule — the
 * rewrite runs on the first fallback they allow (`pickUtilityModelId`), judged by the background models' region
 * rules, so what is picked and where it is routed agree. `ownerId` is the owner of the thread a rewrite continues,
 * when that is not the caller: its messages go to the model too, so both users' filters apply
 * (`loadSharedModelFilterRules`). Refuses (BAD_REQUEST) rather than carry on when the read fails — "no rules" would
 * send the user's text to a model they may have forbidden — and when no model is left.
 */
export const loadOptimizerModel = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string,
    modelId: string,
    ownerId?: string,
): Promise<{ model: string; modelFilterRules: ModelFilterRules }> => {
    let rules: ModelFilterRules;

    try {
        rules = await loadSharedModelFilterRules(ctx, userId, ownerId);
    } catch (error) {
        if (error instanceof ModelFilterRulesUnavailableError) {
            return throwBadRequest(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
        }

        throw error;
    }

    const model = pickUtilityModelId(rules, modelId);

    if (model === undefined) {
        return throwBadRequest(NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE);
    }

    return { model, modelFilterRules: rules };
};

export { MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE } from "./model-filter-rules";
