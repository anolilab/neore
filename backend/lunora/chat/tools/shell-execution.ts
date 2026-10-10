import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Shell Execution Tool
 *
 * Executes shell commands in a persistent E2B sandbox.
 * The sandbox session persists across calls within the same thread.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import type { SandboxOutputFile, SkippedOutputFile } from "./sandbox-outputs";
import { SANDBOX_OUTPUT_INSTRUCTIONS } from "./sandbox-outputs";

export interface ShellResult {
    error?: string;
    exitCode: number;
    files?: SandboxOutputFile[];
    skippedFiles?: SkippedOutputFile[];
    stderr: string;
    stdout: string;
}

/**
 * The shell command to execute.
 */
const shellExecutionTool = createTool<
    {
        command: string;
        timeoutMs?: number;
        workingDir?: string;
    },
    ShellResult,
    ToolContext
>({
    description: `Execute shell commands in a persistent Linux sandbox environment.
The sandbox persists across calls within the same conversation, so you can:
- Install packages (apt-get, pip, npm)
- Compile and run code in any language
- Create, modify, and manage files
- Run build systems, test suites, and development servers
- Use standard Unix tools (git, curl, grep, sed, etc.)

The working directory defaults to /home/user. Files persist between calls.
Use this tool for any task requiring command-line execution.
${SANDBOX_OUTPUT_INSTRUCTIONS}`,
    execute: async (context, input) => {
        const { command, timeoutMs, workingDir } = input;

        toolsLogger.debug(`[SHELL] Executing: ${command.slice(0, 200)}`);

        if (!context.userId) {
            return { error: "Authentication required for shell execution", exitCode: 1, stderr: "Authentication required", stdout: "" };
        }

        if (!context.threadId) {
            return { error: "Thread context required for shell execution", exitCode: 1, stderr: "Thread context required", stdout: "" };
        }

        // Per-user/per-tier rate limit. The sandbox itself is the security
        // boundary, but each call costs real money and a prompt-injected
        // agent can otherwise dispatch unbounded commands.
        const tier = (context as { userTier?: string }).userTier ?? "free";
        const rl = await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
            identifier: context.userId,
            key: `sandbox/execute:${tier}`,
        });

        if (!rl.ok) {
            return {
                error: "Rate limit exceeded",
                exitCode: 1,
                stderr: "Sandbox execution rate limit exceeded.",
                stdout: "",
            };
        }

        try {
            const result = (await context.runAction(internal.chat.tools.sandbox_node.executeShellCommand, {
                command,
                threadId: context.threadId as Id<"threads">,
                timeoutMs,
                userId: context.userId,
                workingDir,
            })) as ShellResult;

            toolsLogger.debug(`[SHELL] Exit code: ${result.exitCode}`);

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[SHELL] Failed: ${errorMessage}`);

            return {
                error: errorMessage,
                exitCode: 1,
                stderr: errorMessage,
                stdout: "",
            };
        }
    },
    inputSchema: z
        .object({
            command: z.string().min(1).max(10_000).meta({ description: "The shell command to execute" }),
            timeoutMs: z.number().optional().meta({ description: "Command timeout in milliseconds (max 300000, default 300000)" }),
            workingDir: z.string().optional().meta({ description: "Working directory (defaults to /home/user)" }),
        })
        .strict(),
    title: "Shell Execution",
});

export default shellExecutionTool;
