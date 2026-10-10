/**
 * The claim-once wrapper for queue jobs that have no row of their own to claim
 * on (`enqueueJob(ref, args, { once })`, `lib/job-queue.ts`). Today that is
 * media generation from `/chat/media`: every delivery would be a paid provider
 * call, and the queue delivers at least once.
 *
 * ## Claim, work, complete — and what a crash costs
 *
 * The claim (`lib/claim-once.ts:claimLease`) is taken BEFORE the target runs and
 * completed after it returns or throws. A redelivery at any point — while the
 * first delivery still runs (a lost ack, a dispatch timeout) or after it ended —
 * finds the claim taken and does nothing, so two paid calls never happen.
 *
 * A target that throws has already handled its failure (the generate actions
 * mark their pending message failed), so a throw completes the claim like a
 * success. A delivery that dies without reaching `finally` (isolate eviction)
 * leaves the lease uncompleted; once it lapses ({@link JOB_LEASE_MS}, longer
 * than any delivery may run) the cron tick runs the job's `onLapse` — for media,
 * `chat/media-abandon.ts` marks the pending message stamped with this `jobId`
 * failed so the UI stops
 * spinning and the user can retry. The job is deliberately NOT re-run: a dead
 * delivery may already have paid for its generation.
 */
import type { FunctionReference } from "lunorash/client";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { JOB_CLAIM_TTL_MS } from "./claim-once";
import { JOB_DISPATCH_TIMEOUT_MS } from "./job-queue-config";

/** Longer than any single delivery may run, so a live delivery is never reaped. */
export const JOB_LEASE_MS = JOB_DISPATCH_TIMEOUT_MS + 60 * 1000;

const JOB_SCOPE = "job";

/** Claim `jobId`, run the `target` action with `args`, then complete the claim. A refused claim runs nothing. */
export const runJobOnce = internalAction
    .input({
        args: v.optional(v.any()),
        jobId: v.string(),
        /** Run once if the delivery dies mid-job (see the module comment). */
        onLapse: v.optional(v.object({ args: v.optional(v.string()), target: v.string() })),
        /** `<module>:<export>` of an internal ACTION — set by `enqueueJob`, never by a client. */
        target: v.string(),
        userId: v.optional(v.string()),
    })
    .output(v.null())
    .action(async ({ args: { args, jobId, onLapse, target, userId }, ctx }) => {
        const claimed = await ctx.runMutation(internal.lib.claim_once.claimKey, {
            key: jobId,
            leaseMs: JOB_LEASE_MS,
            onLapse,
            scope: JOB_SCOPE,
            ttlMs: JOB_CLAIM_TTL_MS,
            userId,
        });

        if (!claimed) {
            return null;
        }

        try {
            const reference = { __lunoraRef: target } as unknown as FunctionReference<"action", Record<string, unknown>, unknown>;

            // The claim key goes along as `jobId`, so the target can tag what it creates with it.
            await ctx.runAction(reference, { ...(args as Record<string, unknown> | undefined), jobId });
        } finally {
            await ctx.runMutation(internal.lib.claim_once.completeKey, { key: jobId, scope: JOB_SCOPE });
        }

        return null;
    });
