/**
 * Pre-warmed Sandbox Pool — Node-runtime actions
 *
 * Maintains a pool of pre-created E2B sandbox instances for faster startup.
 * Instead of creating a sandbox on-demand (which takes 2-5 seconds), we keep
 * a small pool of warm sandboxes ready to be claimed immediately.
 *
 * Architecture:
 * - A cron job runs every 2 minutes to replenish the pool
 * - When a sandbox is needed, we claim one from the pool instead of creating new
 * - Pool target size is configurable (default: 2)
 * - Unclaimed sandboxes are recycled after 10 minutes
 *
 * Queries/mutations live in poolFunctions.ts (V8 runtime — the runtime disallows
 * non-action functions in Node modules).
 */
import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { E2B_API_KEY } from "../env";

("use node");

const POOL_TARGET_SIZE = 2;
const WARM_SANDBOX_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const createWarmSandbox = internalAction.input({}).action(async ({ ctx }) => {
    if (!E2B_API_KEY) {
        return;
    }

    try {
        const { Sandbox } = await import("e2b");
        const sandbox = await Sandbox.create({
            apiKey: E2B_API_KEY,
            timeoutMs: WARM_SANDBOX_TTL_MS,
        });

        await ctx.runMutation(internal.sandbox.pool_functions.registerWarmSandbox, {
            sandboxId: sandbox.sandboxId,
        });
    } catch (error) {
        console.error("[sandbox/pool] Failed to create warm sandbox:", error);
    }
});

export const replenishPool = internalAction.input({}).action(async ({ ctx }) => {
    if (!E2B_API_KEY) {
        return;
    }

    const warmSessions = await ctx.runQuery(internal.sandbox.pool_functions.getWarmSandboxes, {});
    const deficit = POOL_TARGET_SIZE - warmSessions.length;

    if (deficit <= 0) {
        return;
    }

    const toCreate = Math.min(deficit, 2);
    const promises = Array.from({ length: toCreate }, () => ctx.runAction(internal.sandbox.pool.createWarmSandbox, {}));

    await Promise.allSettled(promises);
});

export const cleanupExpiredWarm = internalAction.input({}).action(async ({ ctx }) => {
    if (!E2B_API_KEY) {
        return;
    }

    const warmSessions = await ctx.runQuery(internal.sandbox.pool_functions.getWarmSandboxes, {});
    const now = Date.now();

    for (const session of warmSessions) {
        const age = now - session.startedAt;

        if (age >= WARM_SANDBOX_TTL_MS && session.sandboxId) {
            try {
                const { Sandbox } = await import("e2b");
                const sandbox = await Sandbox.connect(session.sandboxId, {
                    apiKey: E2B_API_KEY,
                });

                await sandbox.kill();
            } catch {
                // Already expired
            }

            await ctx.runMutation(internal.sandbox.functions.closeSession, {
                errorMessage: "Warm sandbox expired without being claimed",
                sessionId: session._id,
                status: "terminated",
            });
        }
    }
});
