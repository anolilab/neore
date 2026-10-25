/**
 * One sub-agent run: a headless agent run (`runHeadlessAgent`) in a new thread,
 * then its answer posted back to the thread that delegated it.
 *
 * On the jobs queue (at-least-once): the run claims its row first
 * (`claimRun`), so only one delivery ever runs it, and reports once at the end
 * (`completeRun`), which posts once. A delivery killed mid-run leaves the row
 * `running` until the reaper fails it. A run the owner cancels is ended by
 * `cancelRun` at once; this loop sees it between steps (`shouldRunStop`) and
 * stops, and its own `completeRun` then finds the run already ended. Enqueued from the parent run's shard —
 * the owner's — so the child thread, its messages and the post-back all live
 * there.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_LOOKUP } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { toUserFacingError } from "../chat/lib/user-facing-error";
import { isTaskModelAllowed } from "../tasks/logic";
import { buildSubAgentPrompt, canNest, resolveSubAgentModel, SUB_AGENT_SYSTEM, SUB_AGENT_TOOL_NAME } from "./logic";

/** A failure this run raised itself, whose message is written for the user. */
class SubAgentRunError extends Error {}

export const runSubAgent = internalAction.input({ runId: v.id("subAgentRuns") }).action(async ({ args: { runId }, ctx }) => {
    const claim = await ctx.runMutation(internal.sub_agents.functions.claimRun, { runId });

    if (!claim) {
        console.warn(`[SubAgent] Run ${runId} already claimed or gone — ignoring a redelivered job`);

        return;
    }

    const { userId } = claim;

    try {
        const skillRun = claim.skillSlug
            ? await ctx.runQuery(internal.skills.executor.resolveSkillsForRun, { organizationId: claim.organizationId, skillSlug: claim.skillSlug, userId })
            : undefined;

        if (skillRun?.error) {
            throw new SubAgentRunError(skillRun.error);
        }

        if (claim.skillSlug && !skillRun?.invocation) {
            throw new SubAgentRunError(`Skill "${claim.skillSlug}" was not found or is not enabled.`);
        }

        const skill = skillRun?.invocation ? { config: skillRun.invocation.config, instructions: skillRun.invocation.instructions } : undefined;
        const model = resolveSubAgentModel({
            defaultModel: DEFAULT_CHAT_MODEL,
            isAllowed: (id) => isTaskModelAllowed(id, (lookupId) => MODEL_LOOKUP.get(lookupId)),
            parentModel: claim.parentModel,
            preferredModel: skill?.config?.preferredModel,
        });

        const { text } = await runHeadlessAgent(ctx, {
            // The parent's `delegateToSubAgent` call only ran past its permission
            // check (approved, or set to `auto`), so that consent carries into
            // this child and nesting stays reachable. At the depth cap the
            // grant is withheld, so a default `ask` removes the tool there.
            ...(canNest(claim.depth) && { approvedTools: [SUB_AGENT_TOOL_NAME] }),
            // An account deletion may have started since the claim; a thread
            // created now would land behind the step that erased the threads.
            beforeThread: async () => {
                if (!(await ctx.runQuery(internal.tasks.internal.canRunForUser, { userId }))) {
                    throw new SubAgentRunError("This account is being deleted.");
                }

                // Cancelled between the claim and now: no thread, no first step.
                if (await ctx.runQuery(internal.sub_agents.functions.shouldRunStop, { runId })) {
                    throw new SubAgentRunError("This sub-agent was stopped.");
                }
            },
            memory: false,
            model,
            onThread: async (childThreadId) => {
                const linked = await ctx.runMutation(internal.sub_agents.functions.attachChildThread, { childThreadId, runId });

                // Stopped after the check in `beforeThread`: nothing points at the
                // new thread, so remove it and run no step.
                if (!linked) {
                    await ctx
                        .runAction(internal.agent.threads.deleteAllForThreadIdSync, { threadId: childThreadId as Id<"threads"> })
                        .catch((error: unknown) => console.error(`[SubAgent] Run ${runId}: could not remove the unlinked thread ${childThreadId}:`, error));

                    throw new SubAgentRunError("This sub-agent was stopped.");
                }
            },
            personalization: "full",
            prompt: buildSubAgentPrompt(claim.task),
            // A failed read is not a stop request: the run goes on and asks again after the next step.
            shouldStop: async () =>
                await ctx.runQuery(internal.sub_agents.functions.shouldRunStop, { runId }).catch((error: unknown) => {
                    console.warn(`[SubAgent] Run ${runId}: could not check for a stop request:`, error);

                    return false;
                }),
            skill,
            system: SUB_AGENT_SYSTEM,
            thread: { tags: ["sub-agent"], title: `Sub-agent: ${claim.task}`.split("\n", 1)[0]!.slice(0, 120) },
            toolAllowlist: claim.toolAllowlist,
            tools: "headless",
            ...(claim.skillSlug &&
                skillRun?.invocation && {
                    usageSkill: { name: `/${claim.skillSlug}`, ...(skillRun.invocation.skillId && { id: skillRun.invocation.skillId }) },
                }),
            userId,
        });

        await ctx.runMutation(internal.sub_agents.functions.completeRun, { outcome: { kind: "succeeded", result: text }, runId });
    } catch (error) {
        console.error(`[SubAgent] Run ${runId} failed:`, error);

        const message = error instanceof SubAgentRunError ? error.message : toUserFacingError(error, { customEndpoint: false });

        await ctx.runMutation(internal.sub_agents.functions.completeRun, { outcome: { error: message, kind: "failed" }, runId });
    }
});
