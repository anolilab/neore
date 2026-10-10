/**
 * Code Execution Node Action
 *
 * Executes Python code in an E2B sandbox. Now accepts optional userId/threadId
 * to route through the shared sandbox session (sandboxNode.ts). Falls back to
 * one-shot sandbox creation for backward compatibility.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import { internalAction } from "../../_generated/server";
import { E2B_API_KEY } from "../../env";

("use node");

export const executeInSandbox = internalAction
    .input({
        code: v.string(),
        threadId: v.optional(v.id("threads")),
        timeoutMs: v.optional(v.number()),
        // Optional: when provided, uses shared persistent sandbox session
        userId: v.optional(v.string()),
    })
    .action(async ({ args: { code, threadId, timeoutMs = 300_000, userId }, ctx }) => {
        // If userId and threadId are provided, use shared sandbox session
        if (userId && threadId) {
            return await ctx.runAction(internal.chat.tools.sandbox_node.executeCode, {
                code,
                threadId,
                timeoutMs,
                userId,
            });
        }

        // Fallback: one-shot sandbox for backward compatibility
        if (!E2B_API_KEY) {
            throw new LunoraError("INTERNAL", "E2B_API_KEY is not configured. Please set it to use code execution.");
        }

        // Loaded on use, like every e2b import — see `sandbox/pty.ts`.
        const { Sandbox } = await import("@e2b/code-interpreter");
        const sandbox = await Sandbox.create({
            apiKey: E2B_API_KEY,
            timeoutMs,
        });

        try {
            const execution = await sandbox.runCode(code);

            const stdout = execution.logs.stdout.join("");
            const stderr = execution.logs.stderr.join("");

            const results: {
                format?: string;
                type: "text" | "image" | "error";
                value: string;
            }[] = [];

            for (const result of execution.results) {
                if (result.png) {
                    results.push({
                        format: "png",
                        type: "image",
                        value: result.png,
                    });
                } else if (result.jpeg) {
                    results.push({
                        format: "jpeg",
                        type: "image",
                        value: result.jpeg,
                    });
                } else if (result.svg) {
                    results.push({
                        format: "svg",
                        type: "image",
                        value: result.svg,
                    });
                } else if (result.text) {
                    results.push({
                        type: "text",
                        value: result.text,
                    });
                }
            }

            return {
                error: execution.error ? `${execution.error.name}: ${execution.error.value}\n${execution.error.traceback}` : undefined,
                results,
                stderr,
                stdout,
            };
        } finally {
            await sandbox.kill();
        }
    });

export default executeInSandbox;
