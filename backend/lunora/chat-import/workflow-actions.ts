import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation } from "../_generated/server";
import { withDependency } from "../lib/dependency";
import { withoutUndefined } from "../lib/patch";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { MAX_LENGTH } from "../lib/validators";
import { keptImportKeyFor, RESTART_WINDOW_MS } from "./restart";

export const startImportWorkflow = internalAction
    .input({
        jobId: v.id("chatImportJobs"),
        provider: v.string(),
        r2Key: v.string().max(MAX_LENGTH.key),
        totalConversations: v.number(),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .action(async ({ args, ctx: context }) => {
        try {
            await withDependency("workflow engine", () => context.workflows.get("chatImportWorkflow").create({ params: args }));
        } catch {
            // No workflow will run to finish the job, so fail it here: otherwise it stays processing and blocks every later import.
            await context.runMutation(internal.chat_import.workflow_actions.failImportStart, { jobId: args.jobId, r2Key: args.r2Key, userId: args.userId });
        }
    });

/**
 * Fail a job whose workflow could not be created. A restart's file is the kept
 * copy and stays restartable; a first run's staging file has nothing kept, so the
 * job is not restartable and the user starts again.
 */
export const failImportStart = internalMutation
    .input({ jobId: v.id("chatImportJobs"), r2Key: v.string().max(MAX_LENGTH.key), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const job = await context.db.get(args.jobId);

        if (!job || job.status !== "processing") {
            return null;
        }

        const keptKey = keptImportKeyFor(args.userId, args.jobId);
        const restart = args.r2Key === keptKey;

        await context.db.patch(
            args.jobId,
            withoutUndefined({
                completedAt: context.now,
                currentStep: "failed",
                errorMessage: "Could not start the import. Please try again.",
                r2Key: restart ? keptKey : "",
                status: "failed",
            }),
        );

        if (restart) {
            await context.scheduler.runAfter(RESTART_WINDOW_MS, internal.chat_import.steps.reapRestartableImport, {
                failedAt: context.now,
                jobId: args.jobId,
                r2Key: keptKey,
            });
        } else {
            await scheduleObjectDeletion(context, [args.r2Key]);
        }

        return null;
    });

export default startImportWorkflow;
