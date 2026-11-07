/**
 * Erasure of a deleted organization's usage (`usageOrganizationDaily`), queued by the organization's deletion
 * (`auth.ts`). Apart from `organization.ts` so the auth wiring can queue it without loading the procedures.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { enqueueJob } from "../lib/job-queue";
import { logger } from "../lib/logger";
import { ROOT_SHARD_KEY } from "../lib/shard-context";
import { MAX_LENGTH } from "../lib/validators";

/** Organization rows one erasure step deletes. */
const ERASE_BATCH = 500;

const usageLogger = logger.scope("usage");

/** A deleted organization's usage, a batch at a time until none is left (queued by the organization's deletion). */
export const eraseOrganizationUsage = internalMutation
    .input({ organizationId: v.string().max(MAX_LENGTH.id) })
    .output(v.number())
    .mutation(async ({ args: { organizationId }, ctx }) => {
        const { page } = await ctx.db.usageOrganizationDaily.findMany({ limit: ERASE_BATCH, where: { organizationId } });

        for (const row of page) {
            await ctx.db.delete("usageOrganizationDaily", row._id);
        }

        if (page.length >= ERASE_BATCH) {
            await ctx.scheduler.runAfter(0, internal.usage.organization_erase.eraseOrganizationUsage, { organizationId });
        }

        return page.length;
    });

/** Queue the erasure of a deleted organization's usage. Never throws: past this, retention removes it in time anyway. */
export const queueOrganizationUsageErase = async (organizationId: string): Promise<void> => {
    try {
        await enqueueJob(internal.usage.organization_erase.eraseOrganizationUsage, { organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        usageLogger.error("Queueing an organization's usage erasure failed", { error, organizationId });
    }
};
