/**
 * The first-run setup checklist's skip and resume. One step per call, applied to the list as it is stored when the
 * mutation runs (a shard runs mutations one at a time), so two tabs or devices that skip different steps both keep
 * their choice. A whole-list overwrite from a client's cache could not promise that.
 */
import { LunoraError, v } from "lunorash/server";

import { authMutation, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { saveUserSettings } from "./lib/preference-writes";
import { capSkippedSteps } from "./lib/setup-step-limits";

/** The code the web card matches to stay silent about a choice that belongs to another account. */
const SETUP_OWNER_MISMATCH = "SETUP_OWNER_MISMATCH";

/** The new skipped list for one step; ids stored by other versions are kept, the oldest going first when the list would pass its limit. */
export const applyStepSkip = (stored: ReadonlyArray<string> | undefined, stepId: string, skipped: boolean): string[] => {
    const rest = (stored ?? []).filter((entry) => entry !== stepId);

    return skipped ? capSkippedSteps([...rest, stepId]) : rest;
};

export const setSetupStepSkipped = authMutation
    .use(rateLimit("settings/update"))
    .input({
        // The account the click was made as: a write the client held while offline and replayed after a switch is refused.
        expectedUserId: v.optional(v.string().max(MAX_LENGTH.id)),
        skipped: v.boolean(),
        stepId: v.union(v.literal("pair"), v.literal("ssh"), v.literal("agent")),
    })
    .output(v.null())
    .mutation(async ({ args: { expectedUserId, skipped, stepId }, ctx }) => {
        const { userId } = ctx.user;

        if (expectedUserId !== undefined && expectedUserId !== userId) {
            // Its own code: a ban or a locked organization also answer FORBIDDEN, and those the user is told about.
            throw new LunoraError("FORBIDDEN", "This choice was made for another account", { data: { code: SETUP_OWNER_MISMATCH } });
        }

        const settings = await ctx.db.userSettings.findFirst({ where: { userId } });

        await saveUserSettings(
            ctx.db,
            settings,
            userId,
            { setupStepsSkipped: applyStepSkip(settings?.setupStepsSkipped, stepId, skipped) },
            ctx.user.activeOrganization?.id ?? null,
        );

        ctx.log.event("auth.set_setup_step_skipped", { skipped, stepId });

        return null;
    });
