import { enabledModelOf, type ModelAccepts, type ModelDefinition, requiresPaidPlan } from "@neore/ai/models";
import { LunoraError } from "lunorash/server";
import type { ActionCtx } from "../../_generated/server";
import { canRunPaidModel } from "./agent-run";
import { byokPaysFor, paidModelRefusal } from "./paid-model";

/**
 * Refuses a model id the action does not run, before any provider call. Unknown, disabled, wrong-kind and
 * capability-less ids all get the same message, so a caller cannot probe which hidden rows exist. Returns the
 * row so the action reads it once. Call it once at the top of the action, with the id already resolved
 * (`resolveWorkflowModel`) when the action has a default.
 */
export const requireEnabledModel = (model: string, accepts: ModelAccepts, noun: string): ModelDefinition => {
    const definition = enabledModelOf(model, accepts);

    if (!definition) {
        throw new LunoraError("BAD_REQUEST", `Model ${model} is not an enabled ${noun} model`);
    }

    return definition;
};

/**
 * Refuses a paid-plan row (`requiresPaidPlan`) for a user who may not run it. The one place a media action
 * asks `canRunPaidModel`, so every action words the refusal the same way.
 */
export const assertPaidModel = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, definition: ModelDefinition): Promise<void> => {
    if (!requiresPaidPlan(definition) || (await canRunPaidModel(ctx, userId, definition))) {
        return;
    }

    throw new LunoraError("FORBIDDEN", paidModelRefusal(definition.name ?? definition.id, byokPaysFor(definition)));
};
