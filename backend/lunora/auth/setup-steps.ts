/**
 * The first-run setup checklist's skip and resume. One step per call, applied to the list as it is stored when the
 * mutation runs (a shard runs mutations one at a time), so two tabs or devices that skip different steps both keep
 * their choice. A whole-list overwrite from a client's cache could not promise that.
 */
import { v } from "lunorash/server";

import { authMutation, rateLimit } from "../lib/crpc";
import { saveUserSettings } from "./lib/preference-writes";

/** The new skipped list for one step; ids stored by other versions are kept. */
export const applyStepSkip = (stored: ReadonlyArray<string> | undefined, stepId: string, skipped: boolean): string[] => {
    const rest = (stored ?? []).filter((entry) => entry !== stepId);

    return skipped ? [...rest, stepId] : rest;
};

export const setSetupStepSkipped = authMutation
    .use(rateLimit("settings/update"))
    .input({
        skipped: v.boolean(),
        stepId: v.union(v.literal("pair"), v.literal("ssh"), v.literal("agent")),
    })
    .output(v.null())
    .mutation(async ({ args: { skipped, stepId }, ctx }) => {
        const { userId } = ctx.user;
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
