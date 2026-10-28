/**
 * Message Worker tool.
 *
 * Sends more work to a worker this conversation started (`delegateToSubAgent` with
 * `persistent: true`): another run in the worker's own thread, which still holds what
 * it did before. The tool returns a receipt at once; the answer is posted to this
 * conversation when the run finishes. The tool call id dedupes a redelivered call
 * (`sub-agents/functions.ts:messageWorker`).
 */
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { SUB_AGENT_TASK_MAX } from "../../sub-agents/logic";

export interface MessageWorkerInput {
    message: string;
    worker: string;
}

export type MessageWorkerOutput = { error: string; status: "failed" } | { message: string; runId: string; state: string; status: "sent" };

const messageWorkerTool = createTool<MessageWorkerInput, MessageWorkerOutput, ToolContext>({
    description: `Send a message to a worker you started with delegateToSubAgent (persistent: true). The worker keeps its thread, so it remembers earlier messages; say what is new, not what it already knows.
- worker: the workerId delegateToSubAgent returned.
- message: what the worker should do next; it cannot ask questions.
A worker handles one message at a time; if it is still working, wait for its result. This tool returns as soon as the message is sent. The worker's result is posted to this conversation as a separate message; do not wait for it or guess it.`,
    execute: async (context, input, options) => {
        if (!context.userId || !context.threadId) {
            return { error: "Sign in to use workers.", status: "failed" };
        }

        const sent = await context.runMutation(internal.sub_agents.functions.messageWorker, {
            message: input.message,
            parentThreadId: context.threadId,
            toolCallId: options.toolCallId,
            userId: context.userId,
            workerId: input.worker,
        });

        if ("error" in sent) {
            return { error: sent.error, status: "failed" };
        }

        return {
            message:
                "The message was sent. The worker's result will be posted to this conversation as a separate message when it finishes. Do not wait for it or guess its result.",
            runId: sent.runId,
            state: sent.state,
            status: "sent",
        };
    },
    inputSchema: z
        .object({
            message: z.string().min(1).max(SUB_AGENT_TASK_MAX).meta({ description: "What the worker should do next" }),
            worker: z.string().min(1).max(128).meta({ description: "The workerId returned when the worker was started" }),
        })
        .strict(),
    title: "Message Worker",
});

export default messageWorkerTool;
