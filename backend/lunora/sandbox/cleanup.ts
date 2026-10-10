/**
 * Sandbox Cleanup
 *
 * Scheduled function that checks if a sandbox session is idle
 * and terminates it if it has exceeded its timeout.
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

        if (result.shouldTerminate && result.sandboxId && E2B_API_KEY) {
            // Loaded on use, like every e2b import — see `sandbox/pty.ts`.
            const { Sandbox } = await import("e2b");

            try {
                const sandbox = await Sandbox.connect(result.sandboxId, {
                    apiKey: E2B_API_KEY,
                });

                await sandbox.kill();
            } catch {
                // Sandbox may already be gone — that's fine
            }
        }
    });

export default checkAndTerminateSandbox;
