/**
 * The write that links a thread to the pull request it opened, retried when it fails. The pull request already exists
 * on the host by then, so a transient error must not leave the thread without it: the write is scheduled again with
 * backoff, a bounded number of times, then given up on with a log line. `recordOpenedPullRequest` is idempotent (a
 * second write for the same pull request is a no-op), so a retry that races an earlier success changes nothing.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";

/** The wait before retry 1, 2 and 3. */
export const PR_LINK_RETRY_DELAYS_MS = [10_000, 60_000, 300_000] as const;

/** Answers that a retry cannot change: the thread is gone or not the run owner's, or the address is not a pull request. */
const PERMANENT_CODES: ReadonlySet<string> = new Set(["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND"]);

export interface OpenedPullRequestLink {
    prUrl: string;
    threadId: string;
    userId: string;
}

type LinkCtx = Pick<ActionCtx, "runMutation" | "scheduler">;

/**
 * Records the link; on a transient failure schedules the next attempt on the owner's shard. `attempt` is the number of
 * retries already made (0 for the first write). Never throws: a link that cannot be recorded must not fail the caller.
 */
export const recordOpenedPullRequestWithRetry = async (ctx: LinkCtx, link: OpenedPullRequestLink, attempt = 0): Promise<void> => {
    try {
        await ctx.runMutation(internal.source_control.pr_threads.recordOpenedPullRequest, link);
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;

        if (typeof code === "string" && PERMANENT_CODES.has(code)) {
            console.error(`[coding-agents] the opened pull request is not linked to thread ${link.threadId}:`, error);

            return;
        }

        const delay = PR_LINK_RETRY_DELAYS_MS[attempt];

        if (delay === undefined) {
            console.error(`[coding-agents] gave up linking the opened pull request to thread ${link.threadId} after ${String(attempt)} retries:`, error);

            return;
        }

        console.error(`[coding-agents] could not link the opened pull request to thread ${link.threadId}, retrying in ${String(delay)} ms:`, error);

        try {
            await runAfterOnShard(
                ctx.scheduler,
                delay,
                internal.source_control.pr_link_retry.retryOpenedPullRequestLink,
                { ...link, attempt: attempt + 1 },
                link.userId,
            );
        } catch (scheduleError) {
            console.error(`[coding-agents] could not schedule the pull request link retry for thread ${link.threadId}:`, scheduleError);
        }
    }
};

/** One scheduled retry of the link write. */
export const retryOpenedPullRequestLink = internalAction
    .input({
        attempt: v.number(),
        prUrl: v.string().max(MAX_LENGTH.url),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const { attempt, ...link } = args;

        await recordOpenedPullRequestWithRetry(ctx, link, attempt);

        return null;
    });
