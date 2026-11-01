import type { ModelFilterRules } from "@neore/ai/models";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";

/**
 * The user's model filters (`{}` when they set none), for a run to read once and hand to both the gateway models
 * (`getAgent({ modelFilterRules })`, which is where `requireZDR` / `denyDataCollection` reach the provider routing)
 * and `resolveBackupModelId`. Every run path loads them here, so the chosen model and its backup are routed alike.
 * Background model calls (`getUtilityModel`) read them the same way.
 */
export const loadModelFilterRules = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<ModelFilterRules> => {
    const preferences = await ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId });

    return preferences?.modelFilterRules ?? {};
};
