/**
 * The chat tool's hand-off: admission, then return at once.
 *
 * The run itself takes up to 20 minutes and runs in the background
 * (`execute.ts`: start, polls, finish). The tool call must not wait for it — the
 * chat agent loop would block, and no action on this runtime may live that long.
 * The user watches the live run view (found by the call's `toolCallId`), and the
 * result arrives as a follow-up assistant message in the thread.
 *
 * Pure over its two dependencies so the hand-off is testable without a backend.
 */
import type { CodingAgentId } from "./commands";
import { CODING_AGENTS, missingKeyMessage } from "./commands";

export interface DelegationInput {
    agent: CodingAgentId;
    branch?: string;
    openPullRequest?: boolean;
    repository: string;
    task: string;
}

export interface DelegationContext {
    threadId?: string;
    toolCallId: string;
    userId?: string;
}

export interface DelegationDependencies {
    createRun: (args: {
        agent: CodingAgentId;
        branch?: string;
        openPr: boolean;
        prompt: string;
        repoUrl: string;
        threadId?: string;
        toolCallId: string;
        userId: string;
    }) => Promise<{ error: string } | { runId: string }>;
    hasProviderKey: (args: { provider: "anthropic" | "openai"; userId: string }) => Promise<boolean>;
}

export type DelegationOutput = { error: string; status: "failed" } | { message: string; runId: string; status: "started" };

export const delegateToCodingAgent = async (
    input: DelegationInput,
    context: DelegationContext,
    dependencies: DelegationDependencies,
): Promise<DelegationOutput> => {
    if (!context.userId) {
        return { error: "Sign in to use coding agents.", status: "failed" };
    }

    const { label, providerKey } = CODING_AGENTS[input.agent];

    if (!(await dependencies.hasProviderKey({ provider: providerKey, userId: context.userId }))) {
        return { error: missingKeyMessage(input.agent), status: "failed" };
    }

    const created = await dependencies.createRun({
        agent: input.agent,
        ...(input.branch && { branch: input.branch }),
        openPr: input.openPullRequest === true,
        prompt: input.task,
        repoUrl: input.repository,
        ...(context.threadId && { threadId: context.threadId }),
        toolCallId: context.toolCallId,
        userId: context.userId,
    });

    if ("error" in created) {
        return { error: created.error, status: "failed" };
    }

    return {
        message: `${label} started in the background and can take up to 20 minutes. The user can follow its live log in the run view; its result will be posted to this conversation as a separate message when it finishes. Do not wait for it or claim what it changed — tell the user it is running.`,
        runId: created.runId,
        status: "started",
    };
};
