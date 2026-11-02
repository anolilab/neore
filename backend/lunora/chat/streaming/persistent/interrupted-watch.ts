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
        // A look that throws (a busy shard, a failed `failRun`) must not end the chain: nothing else would restart it, and the
        // stream would be left to expire. The next look repeats the same decision (a refused resume keeps its reasons on the row).
        try {
            const verdict = await ctx.runMutation(internal.chat.streaming.persistent.interrupted.inspectRun, { streamId: args.streamId });

            if (verdict.kind === "gone") {
                return null;
            }

            if (verdict.kind === "finished") {
                streamLogger.warn(`[BgAgent] Stream ${args.streamId} lost its worker after saving the whole answer; closed`);

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
        } catch (error) {
            streamLogger.error(`[BgAgent] Looking at stream ${args.streamId} failed; looking again:`, error);
        }

        await ctx.scheduler.runAfter(RUN_WATCH_MS, internal.chat.streaming.persistent.interrupted_watch.watchRun, { streamId: args.streamId });

        return null;
    });
