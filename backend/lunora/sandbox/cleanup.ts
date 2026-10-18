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
import { E2B_API_KEY } from "../env";

("use node");

export const checkAndTerminateSandbox = internalAction
    .input({
        sessionId: v.id("sandboxSessions"),
    })
    .action(async ({ args: { sessionId }, ctx }) => {
        const result = await ctx.runMutation(internal.sandbox.functions.checkAndTerminateIdle, {
            sessionId,
        });

        if (!result.shouldTerminate) {
            if (result.recheckInMs !== undefined) {
                await ctx.scheduler.runAfter(result.recheckInMs + 1000, internal.sandbox.cleanup.checkAndTerminateSandbox, { sessionId });
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
                } else {
                    await sandbox.kill();
                }
            } catch {
                // Sandbox may already be gone — that's fine
            }
        }
    });

/** Kill a sandbox by id, for a retired bot computer. Best-effort: it may have timed out already. */
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
