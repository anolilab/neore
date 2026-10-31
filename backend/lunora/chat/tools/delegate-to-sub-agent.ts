/**
 * Delegate to Sub-Agent tool.
 *
 * Hands a self-contained task to a sub-agent: a headless agent run in its own
 * thread, linked under this one (`sub-agents/`). The tool only admits the run
 * and returns; the run continues on the jobs queue, the chat shows its status
 * card, and the answer arrives as a follow-up message in this thread.
 *
 * Caps (depth, concurrent children), the rate limit and the task quota charge
 * are all enforced at admission (`sub-agents/functions.ts:admitSubAgentRun`).
 */
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { SUB_AGENT_MAX_CONCURRENT, SUB_AGENT_MAX_TOOLS, SUB_AGENT_SKILL_SLUG_MAX, SUB_AGENT_TASK_MAX, WORKER_NAME_MAX } from "../../sub-agents/logic";

/** A computer, and the (agent, folder) pair it offered, to run a worker on. */
export interface DelegateHostInput {
    agentKey: string;
    deviceId: string;
    folderId: string;
}

export interface DelegateToSubAgentInput {
    host?: DelegateHostInput;
    name?: string;
    persistent?: boolean;
    skill?: string;
    task: string;
    tools?: string[];
}

export type DelegateToSubAgentOutput = { error: string; status: "failed" } | { message: string; runId: string; status: "started"; workerId?: string };

/** The tool names the lead run can call — what its worker may use at most; `undefined` when the run's tools cannot be read. */
export const leadToolNames = (context: ToolContext): string[] | undefined => {
    const tools = (context.agent?.options as { tools?: Record<string, unknown> } | undefined)?.tools;

    return tools === undefined ? undefined : Object.keys(tools);
};

/** The registry id of the model this run is on — what `getAgent` built the gateway model with. */
const parentModelOf = (context: ToolContext): string | undefined => {
    const languageModel = context.agent?.options.languageModel as { modelId?: unknown } | undefined;

    return typeof languageModel?.modelId === "string" ? languageModel.modelId : undefined;
};

const delegateToSubAgentTool = createTool<DelegateToSubAgentInput, DelegateToSubAgentOutput, ToolContext>({
    description: `Delegate a self-contained piece of work to a sub-agent that runs on its own, in its own thread, while you continue.
Use it for work that splits cleanly off the conversation — researching one side question, drafting a section, comparing options — especially several independent pieces at once (up to ${String(SUB_AGENT_MAX_CONCURRENT)} at a time). Do not use it for a quick answer you can give yourself.
- task: everything the sub-agent needs to know; it cannot see this conversation and cannot ask questions.
- skill: optional slug of one of the user's enabled skills for the sub-agent to run as.
- tools: optional list of tool names to restrict the sub-agent to; omit it for its normal tool set. A sub-agent never gets a tool you do not have.
- host: with persistent, run the worker on a coding agent on one of the user's computers: the computer's id and the agent and folder it offered (they must all be approved on that computer; every start asks the user). Omit it for a worker in the cloud.
- persistent: set true to start a worker — a sub-agent whose thread the user can open and message, and that keeps its context. You can send it more work later with messageWorker, using the workerId this tool returns. Give it a short name.
This tool returns as soon as the sub-agent has started. Its result is posted to this conversation as a separate message when it finishes; do not wait for it or claim what it found — tell the user it is working.`,
    execute: async (context, input, options) => {
        if (!context.userId || !context.threadId) {
            return { error: "Sign in to use sub-agents.", status: "failed" };
        }

        if (!context.dispatchOrigin) {
            return { error: "Sub-agents are unavailable in this run.", status: "failed" };
        }

        if (input.host && !input.persistent) {
            return { error: "A computer is only for a worker: set persistent as well.", status: "failed" };
        }

        // A worker is bounded by its lead's tools, so a lead whose tools are unknown starts none.
        const leadTools = input.persistent ? leadToolNames(context) : undefined;

        if (input.persistent && leadTools === undefined) {
            return { error: "Workers are unavailable in this run.", status: "failed" };
        }

        const parentModel = parentModelOf(context);
        const created = await context.runMutation(internal.sub_agents.functions.createRun, {
            dispatchedBy: context.dispatchOrigin,
            // A headless run cannot be asked to approve: a worker on a computer is out of its reach (checked at admission).
            ...(context.headless && { headless: true }),
            ...(input.host && { host: input.host }),
            ...(parentModel !== undefined && { parentModel }),
            parentThreadId: context.threadId,
            ...(input.persistent && { leadTools, name: input.name, persistent: true }),
            ...(input.skill && { skillSlug: input.skill }),
            task: input.task,
            ...(input.tools && { toolAllowlist: input.tools }),
            toolCallId: options.toolCallId,
            userId: context.userId,
        });

        if ("error" in created) {
            return { error: created.error, status: "failed" };
        }

        return {
            message: created.workerId
                ? `The worker started in the background (workerId ${created.workerId}). Its result will be posted to this conversation as a separate message when it finishes; message it again with messageWorker. Do not wait for it or guess its result — tell the user it is working.`
                : "The sub-agent started in the background. Its result will be posted to this conversation as a separate message when it finishes. Do not wait for it or guess its result — tell the user it is working.",
            runId: created.runId,
            status: "started",
            ...(created.workerId && { workerId: created.workerId }),
        };
    },
    inputSchema: z
        .object({
            host: z
                .object({
                    agentKey: z.string().min(1).max(128).meta({ description: "The agent the computer offered" }),
                    deviceId: z.string().min(1).max(128).meta({ description: "The computer's id" }),
                    folderId: z.string().min(1).max(128).meta({ description: "The folder the computer offered for that agent" }),
                })
                .strict()
                .optional()
                .meta({ description: "Run the worker on a coding agent on one of the user's computers (persistent only; asks the user)" }),
            name: z.string().min(1).max(WORKER_NAME_MAX).optional().meta({ description: "A short name for the worker (persistent only)" }),
            persistent: z.boolean().optional().meta({ description: "Start a worker the user can open and message, which keeps its context between messages" }),
            skill: z.string().min(1).max(SUB_AGENT_SKILL_SLUG_MAX).optional().meta({ description: "Slug of an enabled skill for the sub-agent to use" }),
            task: z.string().min(1).max(SUB_AGENT_TASK_MAX).meta({ description: "The task, with all the context the sub-agent needs" }),
            tools: z
                .array(z.string().min(1).max(128))
                .max(SUB_AGENT_MAX_TOOLS)
                .optional()
                .meta({ description: "Restrict the sub-agent to these tool names; omit for its normal tool set" }),
        })
        .strict(),
    // Starting a worker on a computer needs a click whatever the tool's mode, a timed allow included. A headless run has
    // nobody to click: it is not asked, and the mutation refuses instead.
    needsApproval: (context, input) => context.headless !== true && input.host !== undefined,
    title: "Delegate to Sub-Agent",
});

export default delegateToSubAgentTool;
