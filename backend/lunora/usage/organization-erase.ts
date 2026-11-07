/**
 * Erasure of a deleted organization's usage (`usageOrganizationReplies`), queued by the organization's deletion
 * (`auth.ts`). Apart from `organization.ts` so the auth wiring can queue it without loading the procedures.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { lookUpOrganization } from "../auth/organization-policy-erase";
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
        const { page } = await ctx.db.usageOrganizationReplies.findMany({ limit: ERASE_BATCH, where: { organizationId } });

        for (const row of page) {
            await ctx.db.delete("usageOrganizationReplies", row._id);
        }

        if (page.length >= ERASE_BATCH) {
            await ctx.scheduler.runAfter(0, internal.usage.organization_erase.eraseOrganizationUsage, { organizationId });
        }

        return page.length;
    });

/**
 * Queue the erasure of a deleted organization's usage. Never throws, so a failed send cannot fail the deletion: the
 * daily {@link sweepOrphanedOrganizationUsage} removes what a lost job left.
 */
export const queueOrganizationUsageErase = async (organizationId: string): Promise<void> => {
    try {
        await enqueueJob(internal.usage.organization_erase.eraseOrganizationUsage, { organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        usageLogger.error("Queueing an organization's usage erasure failed; the daily sweep removes it", { error, organizationId });
    }
};

/** Organizations one sweep run looks at before it schedules the next. */
const SWEEP_ORGANIZATIONS = 50;

/**
 * Daily backstop for {@link queueOrganizationUsageErase} (`crons.ts` PERIODIC_JOBS): deletes the usage of
 * organizations that no longer exist. It reads one row per organization, jumping from each organization id to the
 * next, so its cost follows the number of organizations, not of replies. An organization that could not be read is
 * kept. `after` is the last organization id looked at.
 */
export const sweepOrphanedOrganizationUsage = internalMutation
    .input({ after: v.optional(v.string().max(MAX_LENGTH.id)) })
    .output(v.number())
    .mutation(async ({ args, ctx }) => {
        let { after } = args;
        let deleted = 0;

        for (let looked = 0; looked < SWEEP_ORGANIZATIONS; looked += 1) {
            const { page } = await ctx.db.usageOrganizationReplies.findMany({
                limit: 1,
                orderBy: [{ organizationId: "asc" }],
                ...(after !== undefined && { where: { organizationId: { gt: after } } }),
            });
            const [next] = page;

            if (!next) {
                return deleted;
            }

            if ((await lookUpOrganization(ctx.db, next.organizationId)) !== "missing") {
                after = next.organizationId;
                continue;
            }

            const { page: rows } = await ctx.db.usageOrganizationReplies.findMany({ limit: ERASE_BATCH, where: { organizationId: next.organizationId } });

            for (const row of rows) {
                await ctx.db.delete("usageOrganizationReplies", row._id);
            }

            deleted += rows.length;

            // A full batch may have left more of this organization: the next run starts at it again.
            if (rows.length >= ERASE_BATCH) {
                await ctx.scheduler.runAfter(0, internal.usage.organization_erase.sweepOrphanedOrganizationUsage, after === undefined ? {} : { after });

                return deleted;
            }

            after = next.organizationId;
        }

        await ctx.scheduler.runAfter(0, internal.usage.organization_erase.sweepOrphanedOrganizationUsage, after === undefined ? {} : { after });

        return deleted;
    });
