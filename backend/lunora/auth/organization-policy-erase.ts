/**
 * Removing an organization's policy when the organization is deleted, queued
 * from better-auth's delete route (`auth.ts`). Safe to run twice: a second run
 * finds no row.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { enqueueJob } from "../lib/job-queue";
import { logger } from "../lib/logger";
import { ROOT_SHARD_KEY } from "../lib/shard-context";

const policyLogger = logger.scope("organization-policy");

export const deleteOrganizationPolicy = internalMutation
    .input({ organizationId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { organizationId }, ctx }) => {
        const rows = await ctx.db.organizationPolicies.findMany({ where: { organizationId } }).then((result) => result.page);

        for (const row of rows) {
            await ctx.db.delete("organizationPolicies", row._id);
        }

        return null;
    });

/** Queue the removal of a deleted organization's policy. Never throws. */
export const queueOrganizationPolicyErase = async (organizationId: string): Promise<void> => {
    try {
        await enqueueJob(internal.auth.organization_policy_erase.deleteOrganizationPolicy, { organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        policyLogger.error("Queueing an organization's policy removal failed", { error, organizationId });
    }
};
