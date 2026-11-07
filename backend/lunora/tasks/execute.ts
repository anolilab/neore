/**
 * One round of a task: a headless agent run, then the verifier.
 *
 * The run is a `runHeadlessAgent` like a trigger's — a new thread per run, or
 * the last run's thread for a recurring task that keeps one (`pickRunThread`),
 * `generateText` with Deep Work's step budget — plus the interactive run's
 * tool set built `headless`, so a tool the user set to `ask` is simply absent
 * (nobody is there to approve it). The assigned skill contributes its
 * instructions and tool config exactly as a slash command would.
 *
 * State lives in `tasks/internal.ts`: this action claims its round first and
 * reports once at the end, so everything between is safe to lose.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_LOOKUP, type ModelFilterRules } from "@neore/ai/models";
import { generateText } from "ai";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { gatewayFetch, type ServiceFetch } from "../lib/services";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { wrapUntrusted } from "../coding-agents/agent-output";
import type { VerifierVerdict } from "./logic";
import { buildTaskPrompt, buildVerifierPrompt, isPassingFallback, parseVerifierOutput, resolveTaskModel, VERIFIER_SYSTEM_PROMPT } from "./logic";
import { TaskRunError, taskErrorMessage } from "./run-error";
import { vTaskRunOrigin } from "./validators";

const VERIFIER_TIMEOUT_MS = 60_000;

/** Runs the verifier model over the answer. Throws when the model cannot be reached; the caller turns that into a human review. */
const verify = async (input: {
    answer: string;
    /** The calling action's gateway binding. */
    gateway: ServiceFetch;
    instructions: string;
    /** The user's model filter rules, which the verifier model must satisfy. */
    rules: ModelFilterRules;
    successCriteria?: string;
    /** Unset for a coding-agent round, which has no thread. */
    threadId?: string;
    title: string;
    userId: string;
}): Promise<VerifierVerdict> => {
    const { getUtilityModel } = await import("../lib/utility-model");
    const model = await getUtilityModel(input.gateway, { rules: input.rules, threadId: input.threadId, userId: input.userId });
    const result = await generateText({
        abortSignal: AbortSignal.timeout(VERIFIER_TIMEOUT_MS),
        model,
        prompt: buildVerifierPrompt(input),
        system: VERIFIER_SYSTEM_PROMPT,
        temperature: 0,
    });

    return parseVerifierOutput(result.text);
};

/**
 * The repair a round's prompt states. The attempt being repaired (`previousAnswer`) is left out only when the round
 * continues a thread with its history, which holds it already; a new thread or a fresh context gets it.
 */
const repairFor = <T extends { previousAnswer?: string }>(repair: T | undefined, continuesWithHistory: boolean): T | undefined => {
    if (!repair || !continuesWithHistory) {
        return repair;
    }

    return { ...repair, previousAnswer: undefined };
};

const runAgent = async (
    ctx: ActionCtx,
    claim: {
        contextDivider?: boolean;
        continueThreadId?: string;
        freshContext?: boolean;
        goal?: { description?: string; successCriteria?: string; title: string };
        instructions: string;
        keepLastThread?: boolean;
        model?: string;
        organizationId?: string;
        projectId?: Id<"projects">;
        reasoningEffort?: number;
        repair?: { previousAnswer?: string; reasons: string[]; repairInstructions?: string };
        reviewNote?: string;
        skillId?: Id<"skills">;
        successCriteria?: string;
        title: string;
        userId: string;
    },
    onThread: (threadId: string) => void,
    onModel: (model: string) => void,
    /** `keepLastThread` is set when this round falls back for a passing reason (`isPassingFallback`). */
    round: { cycle: string; index: number; keepLastThread: boolean; taskId: Id<"tasks"> },
): Promise<{ answer: string; threadId: string }> => {
    const { userId } = claim;
    const skill = claim.skillId
        ? await ctx.runQuery(internal.tasks.internal.resolveTaskSkill, { organizationId: claim.organizationId, skillId: claim.skillId, userId })
        : undefined;

    if (skill && "error" in skill) {
        throw new TaskRunError(skill.error);
    }

    // `claimRound` already refused a task model that is no longer allowed; a
    // skill's preferred model goes through the same rule a slash command does.
    const model = resolveTaskModel({
        defaultModel: DEFAULT_CHAT_MODEL,
        lookup: (id) => MODEL_LOOKUP.get(id),
        preferredModel: skill?.config?.preferredModel,
        taskModel: claim.model,
    });

    if (!model) {
        throw new TaskRunError("The task's model is no longer available for tasks. Pick another model and run the task again.");
    }

    onModel(model);

    const ensureAccountLive = async (): Promise<void> => {
        // An account deletion may have started since the claim; a thread written
        // now would land behind the step that erased the user's threads.
        if (!(await ctx.runQuery(internal.tasks.internal.canRunForUser, { userId }))) {
            throw new TaskRunError("This account is being deleted.");
        }
    };
    let thread: { tags: string[]; title: string } | { threadId: string } = { tags: ["task"], title: `Task: ${claim.title}`.slice(0, 120) };

    if (claim.continueThreadId) {
        await ensureAccountLive();

        // Re-checked right before the first write: since the claim the thread may have been moved out of the
        // project, locked, or started a chat reply (which holds the thread's run lock). Then a new thread, and why.
        const place = { cycle: round.cycle, round: round.index, taskId: round.taskId, threadId: claim.continueThreadId };
        let problem = await ctx.runQuery(internal.tasks.internal.runThreadProblem, place);

        // The divider is written before the run, so it sits between the last run and this one. A refusal means the
        // thread changed in between, so the reason is asked again.
        if (
            problem === null &&
            claim.contextDivider &&
            !(await ctx.runMutation(internal.agent.context_reset.appendContextReset, { threadId: claim.continueThreadId as Id<"threads">, userId }))
        ) {
            problem = (await ctx.runQuery(internal.tasks.internal.runThreadProblem, place)) ?? "thread_unavailable";
        }

        if (problem === null) {
            thread = { threadId: claim.continueThreadId };
            onThread(claim.continueThreadId);
        } else {
            round.keepLastThread = isPassingFallback(problem);
            await ctx.runMutation(internal.tasks.internal.recordRunNotice, { cycle: round.cycle, reason: problem, taskId: round.taskId });
        }
    }

    // Re-read right before the run uses it: access lost since the claim files nothing and gives no instructions.
    const project = claim.projectId ? await ctx.runQuery(internal.tasks.internal.runProjectFor, { taskId: round.taskId }) : null;

    const { text, threadId } = await runHeadlessAgent(ctx, {
        beforeThread: ensureAccountLive,
        ...(claim.freshContext && "threadId" in thread && { freshContext: true }),
        memory: false,
        model,
        onThread: async (id) => {
            onThread(id);

            // A new thread is filed in the task's project as soon as it exists, so a run that fails is
            // there too and the next run can continue it. A project deleted since the task was saved
            // leaves the thread outside any project rather than failing the run.
            if (project) {
                await ctx
                    .runMutation(internal.agent.threads.moveThreadToProject, { projectId: project.projectId, threadId: id as Id<"threads"> })
                    .catch((error: unknown) => console.warn(`[Tasks] Could not file thread ${id} in project ${project.projectId}:`, error));
            }
        },
        origin: "trigger",
        personalization: "full",
        prompt: buildTaskPrompt({ ...claim, repair: repairFor(claim.repair, "threadId" in thread && !claim.freshContext) }),
        ...(claim.reasoningEffort !== undefined && { reasoningEffort: claim.reasoningEffort }),
        skill,
        // The project's own instructions, framed as a chat in the project gets them (`chat/lib/agent-run.ts`).
        ...(project?.context && { system: `PROJECT CONTEXT:\n${project.context}` }),
        thread,
        tools: "headless",
        ...(skill && claim.skillId && { usageSkill: { id: claim.skillId, name: `/${skill.slug}` } }),
        userId,
    });

    return { answer: text, threadId };
};

/**
 * A round worked by a coding agent instead of the chat agent
 * (`coding-agents/`). The run takes up to 20 minutes and a scheduled action may
 * live at most 15 (the SchedulerDO alarm's wall-time limit), so this only
 * STARTS it: the round stays `running`, and `finishCodingAgentRound` completes
 * it when the run ends. A task is explicit consent, so the chat tool's `ask`
 * default does not apply; the run's own admission checks (one at a time, rate
 * limit, BYOK key) do.
 */
const startCodingAgentRound = async (
    ctx: ActionCtx,
    claim: {
        codingAgent: { agent: "claude_code" | "codex"; branch?: string; openPr?: boolean; repoUrl: string };
        goal?: { description?: string; successCriteria?: string; title: string };
        instructions: string;
        repair?: { previousAnswer?: string; reasons: string[]; repairInstructions?: string };
        reviewNote?: string;
        runId: Id<"taskRuns">;
        successCriteria?: string;
        title: string;
        userId: string;
    },
    taskId: Id<"tasks">,
): Promise<void> => {
    const { codingAgent, userId } = claim;
    const created = await ctx.runMutation(internal.coding_agents.functions.createRun, {
        agent: codingAgent.agent,
        ...(codingAgent.branch && { branch: codingAgent.branch }),
        openPr: codingAgent.openPr === true,
        prompt: buildTaskPrompt(claim),
        repoUrl: codingAgent.repoUrl,
        taskId,
        taskRunId: claim.runId,
        userId,
    });

    if ("error" in created) {
        throw new TaskRunError(created.error);
    }
};

/** A finished coding-agent run as the answer the verifier judges — its summary and diff stat, wrapped as untrusted. */
export const codingAgentAnswer = (run: { diffStat?: string; prUrl?: string; summary?: string }): string =>
    [
        wrapUntrusted(run.summary ?? "(no summary)"),
        run.diffStat ? `Changed files:\n${wrapUntrusted(run.diffStat)}` : "The agent made no file changes.",
        run.prUrl ? `Pull request: ${run.prUrl}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");

/** Verify an answer and complete the round with the verdict (or unverified, when the verifier is down). */
const verifyAndComplete = async (
    ctx: ActionCtx,
    input: {
        answer: string;
        instructions: string;
        keepLastThread?: boolean;
        runId: Id<"taskRuns">;
        successCriteria?: string;
        taskId: Id<"tasks">;
        threadId?: string;
        title: string;
        userId: string;
    },
): Promise<void> => {
    let verdict: VerifierVerdict | undefined;

    try {
        verdict = await verify({ ...input, gateway: gatewayFetch(ctx), rules: await loadModelFilterRules(ctx, input.userId) });
    } catch (error) {
        // The answer exists; only the check is missing. A human decides rather
        // than spending repair rounds on a verifier that is down.
        console.warn(`[Tasks] Verifier failed for task ${input.taskId}:`, error);
    }

    await ctx.runMutation(internal.tasks.internal.completeRound, {
        outcome: verdict ? { finalAnswer: input.answer, kind: "verified", verdict } : { finalAnswer: input.answer, kind: "unverified" },
        ...(input.keepLastThread && { keepLastThread: true }),
        runId: input.runId,
        threadId: input.threadId,
    });
};

/** Completes the round a coding-agent run was started for, once that run has ended (`coding-agents/execute.ts:finishRun`). */
export const finishCodingAgentRound = internalAction
    .input({ codingRunId: v.id("codingAgentRuns") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const run = await ctx.runQuery(internal.coding_agents.functions.getRunForTaskRound, { runId: args.codingRunId });

        if (!run?.taskRunId || !run.taskId) {
            return null;
        }

        // Enqueued on the jobs queue (at-least-once): a redelivery after the
        // round completed must not pay for a second verifier call.
        // `completeRound` refuses a second completion regardless.
        if (!(await ctx.runQuery(internal.tasks.internal.isRoundRunning, { runId: run.taskRunId }))) {
            return null;
        }

        if (run.status !== "succeeded") {
            await ctx.runMutation(internal.tasks.internal.completeRound, {
                outcome: { error: run.error ?? "The coding agent did not finish.", kind: "error" },
                runId: run.taskRunId,
            });

            return null;
        }

        const task = await ctx.runQuery(internal.tasks.internal.getTaskForVerification, { taskId: run.taskId });

        if (!task) {
            return null;
        }

        await verifyAndComplete(ctx, { ...task, answer: codingAgentAnswer(run), runId: run.taskRunId, taskId: run.taskId });

        return null;
    });

export const runTaskRound = internalAction
    .input({ cycle: v.string(), origin: vTaskRunOrigin, round: v.number(), taskId: v.id("tasks") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const claim = await ctx.runMutation(internal.tasks.internal.claimRound, args);

        if (!claim) {
            return null;
        }

        if (claim.codingAgent) {
            try {
                await startCodingAgentRound(ctx, { ...claim, codingAgent: claim.codingAgent }, args.taskId);
            } catch (error) {
                console.error(`[Tasks] Round ${String(args.round)} of task ${args.taskId} could not start its coding agent:`, error);
                await ctx.runMutation(internal.tasks.internal.completeRound, {
                    outcome: { error: taskErrorMessage(error, undefined), kind: "error" },
                    runId: claim.runId,
                });
            }

            return null;
        }

        let threadId: string | undefined;
        let model: string | undefined;
        let answer: string;
        const place = { cycle: args.cycle, index: args.round, keepLastThread: claim.keepLastThread === true, taskId: args.taskId };

        try {
            const run = await runAgent(
                ctx,
                claim,
                (id) => {
                    threadId = id;
                },
                (resolved) => {
                    model = resolved;
                },
                place,
            );

            answer = run.answer.trim();

            if (answer.length === 0) {
                throw new TaskRunError("The agent finished without producing an answer.");
            }
        } catch (error) {
            console.error(`[Tasks] Round ${String(args.round)} of task ${args.taskId} failed:`, error);
            await ctx.runMutation(internal.tasks.internal.completeRound, {
                ...(place.keepLastThread && { keepLastThread: true }),
                outcome: { error: taskErrorMessage(error, model), kind: "error" },
                runId: claim.runId,
                threadId,
            });

            return null;
        }

        await verifyAndComplete(ctx, {
            answer,
            instructions: claim.instructions,
            keepLastThread: place.keepLastThread,
            runId: claim.runId,
            ...(claim.successCriteria !== undefined && { successCriteria: claim.successCriteria }),
            taskId: args.taskId,
            ...(threadId !== undefined && { threadId }),
            title: claim.title,
            userId: claim.userId,
        });

        return null;
    });
