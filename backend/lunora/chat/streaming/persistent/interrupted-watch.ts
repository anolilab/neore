/**
 * The watchdog of one run (`interrupted.ts`): looks at its stream every minute while it is live, resumes it when its
 * worker died, and fails it visibly when it cannot be resumed. One chain per stream, started by the run's first
 * registration; it ends when the stream is no longer live.
 */
import { v } from "lunorash/server";

import { internal } from "../../../_generated/internal";
import { internalAction } from "../../../_generated/server";
import { streamLogger } from "../../../lib/logger";
import { failRun } from "../../lib/agent-run";
import { RUN_WATCH_MS } from "../../lib/interrupted-run";

export const watchRun = internalAction
    .input({ streamId: v.id("persistentStreams") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const verdict = await ctx.runMutation(internal.chat.streaming.persistent.interrupted.inspectRun, { streamId: args.streamId });

        if (verdict.kind === "gone") {
            return null;
        }

        if (verdict.kind === "fail") {
            streamLogger.warn(`[BgAgent] Stream ${args.streamId} was interrupted and is not resumed: ${verdict.message}`);
            await failRun(ctx, { safeMessage: verdict.message, streamId: args.streamId, threadId: verdict.threadId, threadStatus: "error" });

            return null;
        }

        if (verdict.kind === "resumed") {
            streamLogger.warn(`[BgAgent] Stream ${args.streamId} lost its worker; resume queued`);
        }

        await ctx.scheduler.runAfter(RUN_WATCH_MS, internal.chat.streaming.persistent.interrupted_watch.watchRun, { streamId: args.streamId });

        return null;
    });
