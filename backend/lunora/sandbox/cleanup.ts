/**
 * Sandbox Cleanup
 *
 * Scheduled function that checks if a sandbox session is idle. An idle thread
 * sandbox is killed; an idle bot computer is paused, so its state survives until
 * the next call resumes it. A session that is not idle yet is checked again when
 * its idle window runs out.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { E2B_API_KEY } from "../env";

("use node");

/** A failed pause is retried this many times; past that, E2B's lifetime cap pauses the computer. */
const MAX_PAUSE_ATTEMPTS = 5;
const PAUSE_RETRY_MS = 60_000;
/** Bounds an E2B pause or kill, so a stalled call cannot hang the cleanup action. */
const CLEANUP_REQUEST_TIMEOUT_MS = 15_000;

export const checkAndTerminateSandbox = internalAction
    .input({
        pauseAttempt: v.optional(v.number()),
        sessionId: v.id("sandboxSessions"),
    })
    .output(v.null())
    .action(async ({ args: { pauseAttempt = 1, sessionId }, ctx }) => {
        const result = await ctx.runMutation(internal.sandbox.functions.checkAndTerminateIdle, {
            sessionId,
        });

        if (!result.shouldTerminate) {
            if (result.recheckInMs !== undefined && result.userId !== undefined) {
                await runAfterOnShard(
                    ctx.scheduler,
                    result.recheckInMs + 1000,
                    internal.sandbox.cleanup.checkAndTerminateSandbox,
                    { sessionId },
                    result.userId,
                );
            }

            return null;
        }

        const { sandboxId } = result;

        if (sandboxId && E2B_API_KEY) {
            // Loaded on use, like every e2b import — see `sandbox/pty.ts`.
            const { Sandbox, SandboxNotFoundError } = await import("e2b");
            // Static calls: connecting to a paused computer would resume it just to pause it again.
            const options = { apiKey: E2B_API_KEY, requestTimeoutMs: CLEANUP_REQUEST_TIMEOUT_MS };

            try {
                if (result.pause) {
                    // `pause` answers false when the computer was already paused, which is still the recorded state.
                    await Sandbox.pause(sandboxId, options);

                    if (result.decidedAt !== undefined) {
                        await ctx.runMutation(internal.sandbox.functions.markBotComputerPaused, { decidedAt: result.decidedAt, sessionId });
                    }
                } else {
                    await Sandbox.kill(sandboxId, options);
                }
            } catch (error) {
                if (error instanceof SandboxNotFoundError) {
                    // E2B no longer has the computer: its session is over, and retrying cannot bring it back.
                    await ctx.runMutation(internal.sandbox.functions.closeSession, {
                        errorMessage: "Computer no longer available",
                        sessionId,
                        status: "terminated",
                    });

                    return null;
                }

                // Any other failure of a bot's computer is retried, so it does not run on until its lifetime cap;
                // the retry stops after a few attempts.
                if (result.pause && result.userId !== undefined && pauseAttempt < MAX_PAUSE_ATTEMPTS) {
                    await runAfterOnShard(
                        ctx.scheduler,
                        PAUSE_RETRY_MS,
                        internal.sandbox.cleanup.checkAndTerminateSandbox,
                        { pauseAttempt: pauseAttempt + 1, sessionId },
                        result.userId,
                    );
                }
            }
        }

        return null;
    });

export const killSandboxById = internalAction
    .input({
        sandboxId: v.string(),
    })
    .output(v.null())
    .action(async ({ args: { sandboxId } }) => {
        if (!E2B_API_KEY) {
            return null;
        }

        try {
            const { Sandbox } = await import("e2b");

            await Sandbox.kill(sandboxId, { apiKey: E2B_API_KEY, requestTimeoutMs: CLEANUP_REQUEST_TIMEOUT_MS });
        } catch {
            // Already gone — nothing to kill.
        }

        return null;
    });

export default checkAndTerminateSandbox;
