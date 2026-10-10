/**
 * Delegate to Coding Agent tool.
 *
 * Hands a coding task to Claude Code or OpenAI Codex running non-interactively
 * in an E2B sandbox against a repository the user names (`coding-agents/`).
 *
 * The tool only starts the run and returns (`coding-agents/delegate.ts`); the
 * run continues in the background, the run view shows its live log, and the
 * result arrives as a follow-up assistant message in the thread.
 *
 * Defaults to `ask` in the permission layer (`chat/lib/tool-permissions.ts`):
 * it spends the user's own provider key and can push to their GitHub.
 */
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { PROMPT_MAX } from "../../coding-agents/commands";
import type { DelegationInput, DelegationOutput } from "../../coding-agents/delegate";
import { delegateToCodingAgent } from "../../coding-agents/delegate";

export type DelegateToCodingAgentOutput = DelegationOutput;

const delegateToCodingAgentTool = createTool<DelegationInput, DelegationOutput, ToolContext>({
    description: `Delegate a coding task to an autonomous coding agent (Claude Code or OpenAI Codex) that clones a git repository into a cloud sandbox, makes the change, and reports a summary and diff.
Use it when the user asks to have code in a repository changed, fixed, refactored or implemented — not for answering questions about code.
- repository: an https:// git URL or GitHub "owner/repo". Private GitHub repositories work when the user connected GitHub.
- agent: "claude_code" (uses the user's Anthropic key) or "codex" (uses the user's OpenAI key). Pick the one the user asked for; default to claude_code.
- openPullRequest: true ONLY if the user explicitly asked for a pull request.
The run happens in the background (up to 20 minutes): this tool returns as soon as it has started, the user follows the live log, and the result is posted to the conversation when it finishes. Only one run per user at a time.`,
    execute: async (context, input, options) =>
        await delegateToCodingAgent(
            input,
            { ...(context.threadId && { threadId: context.threadId }), toolCallId: options.toolCallId, ...(context.userId && { userId: context.userId }) },
            {
                createRun: async (args) => await context.runMutation(internal.coding_agents.functions.createRun, args),
                hasProviderKey: async (args) => await context.runQuery(internal.coding_agents.functions.hasProviderKey, args),
            },
        ),
    inputSchema: z
        .object({
            agent: z.enum(["claude_code", "codex"]).default("claude_code").meta({ description: "Which coding agent CLI to run" }),
            branch: z.string().max(200).optional().meta({ description: "Branch to check out; defaults to the repository's default branch" }),
            openPullRequest: z.boolean().optional().meta({ description: "Open a GitHub pull request with the change. Only when the user asked for one." }),
            repository: z.string().min(1).max(500).meta({ description: 'Repository: https:// git URL or GitHub "owner/repo"' }),
            task: z.string().min(1).max(PROMPT_MAX).meta({ description: "What the coding agent should do, with all the context it needs" }),
        })
        .strict(),
    title: "Delegate to Coding Agent",
});

export default delegateToCodingAgentTool;
