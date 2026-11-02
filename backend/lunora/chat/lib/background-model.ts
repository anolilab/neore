import { type ModelFilterRules, requiresPaidPlan } from "@neore/ai/models";

import type { ActionCtx } from "../../_generated/server";
import { pickUtilityModelId } from "../../lib/utility-model";
import { loadModelFilterRules, loadSharedModelFilterRules } from "./model-filter-rules";

/**
 * The model for a background agent call that builds its own agent (titles, categories, summaries, follow-ups):
 * `preferred`, or the first fallback the user's model filter rules allow, with the rules to hand to
 * `getAgent({ modelFilterRules })`. `undefined` when the rules allow none: the caller skips its step. `planUserId` is whose plan opens paid models when the
 * rules' owner is not the one paying.
 *
 * `billedUserId` is set only when the model chosen is outside the free tier (a paid fallback): the platform's own
 * default stays unmetered, as before, while a model the user's plan unlocked is metered to that user.
 *
 * `sharedWithCaller` is for a call whose prompt also carries the caller's own profile (`getAgentForUser`): the
 * model must then satisfy the caller's rules as well as the owner's (`planUserId` is the caller).
 */
export const resolveBackgroundModel = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string | undefined,
    preferred: string,
    planUserId?: string,
    sharedWithCaller = false,
): Promise<{ billedUserId?: string; model: string; modelFilterRules: ModelFilterRules } | undefined> => {
    // Unreadable rules skip the step: picking a model without them could send the content to one the user forbade.
    let load: Promise<ModelFilterRules>;

    if (!userId) {
        load = Promise.resolve({});
    } else if (sharedWithCaller && planUserId) {
        load = loadSharedModelFilterRules(ctx, planUserId, userId);
    } else {
        load = loadModelFilterRules(ctx, userId, planUserId);
    }

    const modelFilterRules = await load.catch(() => undefined);

    if (modelFilterRules === undefined) {
        return undefined;
    }

    const model = pickUtilityModelId(modelFilterRules, preferred);

    if (model === undefined) {
        return undefined;
    }

    const billedUserId = requiresPaidPlan({ id: model }) ? (planUserId ?? userId) : undefined;

    return { ...(billedUserId && { billedUserId }), model, modelFilterRules };
};
