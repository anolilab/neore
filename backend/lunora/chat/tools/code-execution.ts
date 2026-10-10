import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";

/**
 * Code Execution Tool
 * Executes Python code in an E2B sandbox with support for data analysis and visualization
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import type { SandboxOutputFile, SkippedOutputFile } from "./sandbox-outputs";
import { SANDBOX_OUTPUT_INSTRUCTIONS } from "./sandbox-outputs";

export interface ExecutionResult {
    error?: string;
    files?: SandboxOutputFile[];
    results: {
        format?: string;
        type: "text" | "image" | "error";
        value: string;
    }[];
    skippedFiles?: SkippedOutputFile[];
    stderr: string;
    stdout: string;
}

/**
 * The Python code to execute.
 */
const codeExecutionTool = createTool<
    {
        code: string;
        language?: "python";
    },
    ExecutionResult,
    ToolContext
>({
    description: `Execute Python code in a sandboxed environment with pre-installed packages.
Available packages: matplotlib, pandas, numpy, sympy, scipy, seaborn, plotly, yfinance, requests, beautifulsoup4, pillow.
Additional packages can be installed via \`!pip install package_name\` or \`import subprocess; subprocess.run(["pip", "install", "package_name"])\`.
Use this tool to:
- Run calculations and data analysis
- Create charts and visualizations (matplotlib, plotly, seaborn)
- Process and transform data
- Demonstrate code execution results
Charts are not displayed from plt.show(); save them instead (e.g. plt.savefig("/home/user/output/chart.png")).
${SANDBOX_OUTPUT_INSTRUCTIONS}`,
    execute: async (context, input) => {
        const { code } = input;

        toolsLogger.debug(`[CODE_EXEC] Executing code (${code.length} chars)`);

        // Per-user/per-tier rate limit. E2B sandboxes cost real money per
        // run; without this, a prompt-injected agent or malicious user can
        // chain hundreds of executions in a single thread.
        if (context.userId) {
            const tier = (context as { userTier?: string }).userTier ?? "free";
            const rl = await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
                identifier: context.userId,
                key: `sandbox/execute:${tier}`,
            });

            if (!rl.ok) {
                return {
                    error: "Rate limit exceeded",
                    results: [{ type: "error" as const, value: "Sandbox execution rate limit exceeded." }],
                    stderr: "",
                    stdout: "",
                };
            }
        }

        try {
            const result = (await context.runAction(internal.chat.tools.code_execution_node.executeInSandbox, {
                code,
                threadId: context.threadId as Id<"threads">,
                // Pass userId/threadId to use shared persistent sandbox when available
                userId: context.userId,
            })) as ExecutionResult;

            toolsLogger.debug(`[CODE_EXEC] Execution complete: ${result.results.length} results, ${result.error ? "with error" : "success"}`);

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[CODE_EXEC] Sandbox execution failed: ${errorMessage}`);

            return {
                error: errorMessage,
                results: [{ type: "error" as const, value: errorMessage }],
                stderr: "",
                stdout: "",
            };
        }
    },
    inputSchema: z
        .object({
            code: z.string().min(1).max(50_000).meta({ description: "The Python code to execute" }),
            language: z.enum(["python"]).optional().default("python").meta({ description: "Programming language (currently only Python is supported)" }),
        })
        .strict(),
    title: "Code Execution",
});

export default codeExecutionTool;
