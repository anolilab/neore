/**
 * Removing an organization's policy when the organization is deleted, queued
 * from better-auth's delete route (`auth.ts`). Safe to run twice: a second run
 * finds no row.
 *
 * The queue is only the prompt path: if the enqueue fails after the organization
 * is gone, nothing retries it. `sweepOrphanedOrganizationPolicies`, run by the
 * daily cron tick, finds those rows by reading the organization table instead.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
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

/** Policy rows one sweep run looks at; a run that did not reach the end schedules the next page itself. */
const ORPHAN_SWEEP_PAGE_SIZE = 100;

/** What reading one policy's organization came to. */
export type OrganizationLookup = "exists" | "missing" | "unreadable";

/** A policy row goes only when its organization was read and is not there. */
export const shouldDeleteOrphanedPolicy = (lookup: OrganizationLookup): boolean => lookup === "missing";

const lookUpOrganization = async (db: MutationCtx["db"], organizationId: string): Promise<OrganizationLookup> => {
    try {
        const organization = await db.organization.findFirst({ where: { _id: db.asId("organization", organizationId) } });

        return organization === null ? "missing" : "exists";
    } catch (error) {
        policyLogger.error("Reading an organization during the policy sweep failed; its policy is kept", { error, organizationId });

        return "unreadable";
    }
};

/**
 * One page of the reconciliation sweep: delete the policies whose organization
 * no longer exists. Independent of the enqueue above. A row whose organization
 * could not be read is kept, and a row rewritten since it was read is left for
 * the next run, so a stale decision never deletes a newer policy.
 */
export const sweepOrphanedPolicyPage = async (
    db: MutationCtx["db"],
    cursor: string | undefined,
): Promise<{ continueCursor: string | undefined; deleted: number }> => {
    const page = await db.organizationPolicies.findMany({ cursor, limit: ORPHAN_SWEEP_PAGE_SIZE });
    let deleted = 0;

    for (const row of page.page) {
        if (!shouldDeleteOrphanedPolicy(await lookUpOrganization(db, row.organizationId))) {
            continue;
        }

        const current = await db.get("organizationPolicies", row._id);

        if (current === null || current.revision !== row.revision) {
            continue;
        }

        await db.delete("organizationPolicies", row._id);
        deleted += 1;
    }

    return { continueCursor: page.isDone ? undefined : (page.continueCursor ?? undefined), deleted };
};

/** Daily cron job (`crons.ts` PERIODIC_JOBS); runs on `__root__` with the other global-table sweeps. */
export const sweepOrphanedOrganizationPolicies = internalMutation
    .input({ cursor: v.optional(v.string()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { continueCursor, deleted } = await sweepOrphanedPolicyPage(ctx.db, args.cursor);

        if (deleted > 0) {
            policyLogger.info("Removed policies of deleted organizations", { deleted });
        }

        if (continueCursor !== undefined) {
            await ctx.scheduler.runAfter(0, internal.auth.organization_policy_erase.sweepOrphanedOrganizationPolicies, { cursor: continueCursor });
        }

        return null;
    });
