/**
 * The `onLapse` of a media generation on the jobs queue (`lib/job-once.ts`):
 * its delivery died mid-run, so its pending "generating…" row would spin
 * forever. Mark it failed — the user sees why and can retry. The paid call is
 * never re-run.
 *
 * The row is tied to the job exactly: `runJobOnce` hands the target its claim
 * key as `jobId`, and the generate actions stamp it on the pending row they
 * create ({@link mediaJobStamp}, in `providerMetadata`). Only a pending row
 * carrying that key is failed. None means the delivery died before creating
 * one — nothing is spinning, so nothing is done.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { patchRow } from "../lib/patch";

/** The `providerMetadata` namespace the job stamp lives under. */
const JOB_STAMP_NAMESPACE = "neoreJob";

export const ABANDONED_MEDIA_TEXT = "*Generation did not finish. Please try again.*";

/** `providerMetadata` for a pending media row started by queue job `jobId`; nothing for a direct call. */
export const mediaJobStamp = (jobId: string | undefined): Record<string, Record<string, string>> | undefined =>
    jobId === undefined ? undefined : { [JOB_STAMP_NAMESPACE]: { jobId } };

const stampedJobId = (providerMetadata: unknown): unknown =>
    (providerMetadata as Record<string, Record<string, unknown> | undefined> | undefined)?.[JOB_STAMP_NAMESPACE]?.jobId;

export const failAbandonedMediaJob = internalMutation
    .input({
        /** The job's claim key — its `jobId` (added by `reapLapsedClaims`). */
        claimKey: v.string(),
        threadId: v.id("threads"),
    })
    .output(v.boolean())
    .mutation(async ({ args: { claimKey, threadId }, ctx }) => {
        const pending = await ctx.db
            .query("messages")
            .withIndex("threadId_status_tool_order_stepOrder", (q) => q.eq("threadId", threadId).eq("status", "pending").eq("tool", false))
            .collect();
        const row = pending.find((message) => stampedJobId(message.providerMetadata) === claimKey);

        if (!row) {
            return false;
        }

        await patchRow(ctx.db, row, {
            error: "The generation stopped before it finished.",
            message: { content: [{ text: ABANDONED_MEDIA_TEXT, type: "text" }], role: "assistant" },
            status: "failed",
            text: ABANDONED_MEDIA_TEXT,
        });

        return true;
    });
