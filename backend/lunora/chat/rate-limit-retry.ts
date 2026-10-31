/**
 * "Retry now" for a run that is waiting out a provider's rate limit
 * (`chat/lib/rate-limit-pause.ts`). Stopping it is the ordinary stop
 * (`abortThreadStream`); this ends the wait early instead.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { authMutation, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { threadGateOutcome, throwUnlessGranted } from "./lib/thread-gate";

/**
 * Resume the thread's paused run now. Same caller check as Stop (write access to the thread). The resume is the one the
 * pause queued for its retry time, queued again for now: whichever runs first claims the pause, the other does nothing,
 * so a double click or a click at the moment the wait ends resumes the run once.
 */
export const retryRateLimitedRun = authMutation
    .use(rateLimit("chat/stream"))
    .input({ threadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.object({ resumed: v.boolean() }))
    .mutation(async ({ args: { threadId, unlockProof }, ctx }) => {
        const { userId } = ctx.user;

        throwUnlessGranted(await threadGateOutcome(ctx, { level: "write", threadId, unlockProof, userId }), "Write access denied to this thread");

        const resumed = await ctx.runMutation(internal.chat.streaming.persistent.library.retryPausedRunsNow, { threadId });

        ctx.log.event("chat.retry_rate_limited_run", { resumed });

        return { resumed };
    });
