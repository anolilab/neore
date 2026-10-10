/**
 * The second half of answering a paused run, shared by `respondToToolApproval`
 * (`chat/tool-permissions.ts`) and `answerAskUser` (`chat/ask-user.ts`): once
 * the snapshot is claimed (`lib/tool-approval-claim.ts`), open a fresh stream on
 * the thread, enqueue `continueAfterToolApproval` and mark the thread running.
 *
 * The continuation runs as the OWNER — the snapshot, tools, keys and thread are
 * theirs.
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { enqueueJob } from "../../lib/job-queue";
import { persistentTextStreaming } from "../streaming";
import type { ToolRunConfig } from "./tool-run-config";

export interface ResumeClaimedRunArgs {
    /** The user's answer, for an approved `askUser` call — becomes the tool result. */
    answer?: string;
    approvalId: string;
    approved: boolean;
    config: ToolRunConfig;
    /** For a denied call: what the model is told instead of the default denial. */
    denyReason?: string;
    ownerId: string;
    runId: Id<"toolApprovalRuns">;
    threadId: Id<"threads">;
}

/** Returns the new stream's id, which the claimed row now records. */
export const resumeClaimedRun = async (ctx: MutationCtx, args: ResumeClaimedRunArgs): Promise<string> => {
    const { answer, approvalId, approved, config, denyReason, ownerId, runId, threadId } = args;
    const streamId = await persistentTextStreaming.createStream(ctx, {
        messageId: approvalId,
        streamingConfig: {
            contentType: "text",
            model: config.model,
            ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
            searchMode: config.searchMode,
        },
        threadId,
        userId: ownerId,
    });

    await ctx.db.patch(runId, { streamId });

    // On the jobs queue, like the run it resumes (`lib/job-queue.ts`); it claims its stream first.
    await enqueueJob(internal.chat.execute.continueAfterToolApproval, {
        ...(answer !== undefined && { answer }),
        approvalId,
        approved,
        config,
        ...(denyReason !== undefined && { denyReason }),
        streamId,
        threadId,
        userId: ownerId,
    });

    await ctx.scheduler.runAfter(0, internal.agent.threads.updateThread, {
        patch: { status: "running", updatedAt: Date.now() },
        threadId,
    });

    return streamId;
};
