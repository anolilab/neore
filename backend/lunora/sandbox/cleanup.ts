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

export const checkAndTerminateSandbox = internalAction
    .input({
        pauseAttempt: v.optional(v.number()),
        sessionId: v.id("sandboxSessions"),
    })
    .action(async ({ args: { pauseAttempt = 1, sessionId }, ctx }) => {
        const result = await ctx.runMutation(internal.sandbox.functions.checkAndTerminateIdle, {
            sessionId,
        });

        if (!result.shouldTerminate) {
            if (result.recheckInMs !== undefined) {
                await runAfterOnShard(
                    ctx.scheduler,
                    result.recheckInMs + 1000,
                    internal.sandbox.cleanup.checkAndTerminateSandbox,
                    { sessionId },
                    result.userId,
                );
            }

            return;
        }

        if (result.sandboxId && E2B_API_KEY) {
            // Loaded on use, like every e2b import — see `sandbox/pty.ts`.
            const { Sandbox } = await import("e2b");

            try {
                const sandbox = await Sandbox.connect(result.sandboxId, {
                    apiKey: E2B_API_KEY,
                });

                if (result.pause) {
                    await sandbox.pause();

                    if (result.decidedAt !== undefined) {
                        await ctx.runMutation(internal.sandbox.functions.markBotComputerPaused, { decidedAt: result.decidedAt, sessionId });
                    }
                } else {
                    await sandbox.kill();
                }
            } catch {
                // Sandbox may already be gone. A bot's computer whose pause failed is retried, so it does not run on
                // until its lifetime cap; the retry stops after a few attempts.
                if (result.pause && pauseAttempt < MAX_PAUSE_ATTEMPTS) {
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
    });

/** A scheduled kill must not hang the cleanup action when E2B stalls. */
const KILL_REQUEST_TIMEOUT_MS = 15_000;

export const killSandboxById = internalAction
    .input({
        sandboxId: v.string(),
    })
    .action(async ({ args: { sandboxId } }) => {
        if (!E2B_API_KEY) {
            return;
        }

        try {
            const { Sandbox } = await import("e2b");

            await Sandbox.kill(sandboxId, { apiKey: E2B_API_KEY, requestTimeoutMs: KILL_REQUEST_TIMEOUT_MS });
        } catch {
            // Already gone — nothing to kill.
        }
    });

export default checkAndTerminateSandbox;
