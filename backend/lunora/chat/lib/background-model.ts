import type { ModelFilterRules } from "@neore/ai/models";

import type { ActionCtx } from "../../_generated/server";
import { pickUtilityModelId } from "../../lib/utility-model";
import { loadModelFilterRules } from "./model-filter-rules";

/**
 * The model for a background agent call that builds its own agent (titles, categories, summaries, follow-ups):
 * `preferred`, or the first fallback the user's model filter rules allow, with the rules to hand to
 * `getAgent({ modelFilterRules })`. `undefined` when the rules allow none: the caller skips its step.
 */
export const resolveBackgroundModel = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string | undefined,
    preferred: string,
): Promise<{ model: string; modelFilterRules: ModelFilterRules } | undefined> => {
    const modelFilterRules = userId ? await loadModelFilterRules(ctx, userId) : {};
    const model = pickUtilityModelId(modelFilterRules, preferred);

    return model === undefined ? undefined : { model, modelFilterRules };
};
