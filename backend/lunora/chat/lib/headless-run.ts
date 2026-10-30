/**
 * An agent run nobody watches: `generateText` instead of a stream, no approval
 * pauses, one answer back. Triggers, tasks and messenger replies all run here,
 * so they read the user's settings the same way and differ only where they say
 * so:
 *
 * - `memory`: memories are retrieved into the system prompt and extracted from
 *   the exchange afterwards. Off for a messenger reply — its sender is a third
 *   party, who must neither read the owner's memories nor write to them.
 * - `personalization`: `"full"` puts the user's about-me, nickname, profession,
 *   custom instructions and location into the prompt — for runs whose audience
 *   is the user. `"none"` for a messenger reply: its reader is a third party,
 *   and the model would repeat what it was told about the owner. Language and
 *   timezone stay either way — the reply's language, and the prompt's only
 *   source of the current date and time.
 * - `tools`: `"headless"` builds the interactive tool set without anything the
 *   user set to `ask` (nobody is there to approve it); `"none"` runs text-only.
 *
 * The user's own provider keys and custom endpoints apply to every headless run.
 */
import { stepCountIs } from "ai";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { sumMessageCosts } from "../../agent/message-cost";
import { type GoalRoundResult, runHeadlessGoalRounds, stepsTranscript } from "../goals/headless";
import type { HeadlessGoalOutcome } from "../goals/headless";
import { reviewRound } from "../goals/review";
import type { SkillConfig } from "../../skills/validators";
import type { DispatchOrigin } from "../../sub-agents/logic";
import {
    buildRunStreamArgs,
    loadModelFilterRules,
    loadUserProviderKeys,
    resolveBackupModelId,
    resolveRunModel,
    retrieveMemoryContext,
    setDispatchOrigin,
    setResearchDepth,
    toPersonalization,
} from "./agent-run";
import { buildAgentTools } from "./agent-tools";
import { getMaxSteps } from "./auto-continue";
import { gatewayFetch } from "../../lib/services";
import getAgent from "./get-agent";
import { closeMCPClients } from "./mcp-tools";
import type { SearchMode } from "./tool-builder";
import { servesUser } from "../../lib/shard-context";
import { applyToolAllowlist, stopWhenRequested } from "../../sub-agents/logic";
import type { ReplySkill, SavedRowLike } from "../../usage/activity-logic";
import { replyUsageArgs } from "../../usage/activity-logic";
import { scheduleReplyUsage } from "../../usage/schedule";

/** Autonomous work benefits from search; a skill's own search mode still wins. */
const DEFAULT_HEADLESS_SEARCH_MODE: SearchMode = "web";

export interface HeadlessRunOptions {
    /**
     * Built-ins offered beyond the headless search mode's set, like a skill's
     * extra tools: still subject to the user's permissions and to
     * {@link HeadlessRunOptions.toolAllowlist}.
     */
    additionalTools?: ReadonlyArray<string>;
    /**
     * Built-ins whose `ask` this run inherited an approval for, so they stay
     * (as `auto`) instead of being removed — only for a run started by an
     * approved call of that tool (`sub-agents/execute.ts`).
     */
    approvedTools?: ReadonlyArray<string>;
    /** Runs once the agent is built, right before a new thread is created — the last point to refuse. */
    beforeThread?: () => Promise<void>;
    /** The bot the run is for: its memories are read and written in that bot's scope. Unset = the user's own. */
    botId?: string;
    /**
     * Run until done: after the run, a short review decides whether `text` is met, and if not the run goes on
     * in the same thread with the reviewer's reason as the next instruction, up to `maxRounds` (default 5, at
     * most 10) and a cost cap. Each further round is charged to the user's daily limits. Unset, the run is one
     * `generateText`. The rounds run inside this call, so they also stop at a time budget (`headless.ts`).
     */
    goal?: { maxRounds?: number; text: string };
    /** Leave an existing thread's status as it is, instead of marking it active when the run ends. */
    keepThreadStatus?: boolean;
    /** A step cap for a quick reply. Default: Deep Work's budget, with context compression between steps. */
    maxSteps?: number;
    /** Retrieve memories before, and extract them after. */
    memory: boolean;
    model: string;
    /**
     * Called right before the model is asked, after the model, keys, tools and thread are ready: the
     * point from which a failure means the run reached the model (and may have been billed). A caller
     * that must give something back when a run never started tells the two apart with it.
     */
    onGenerationStart?: () => Promise<void> | void;
    /** Called with the new thread's id before generation starts, so a failure can still point at it. */
    onThread?: (threadId: string) => Promise<void> | void;
    /**
     * What started this run. A dispatch to a worker from its tools carries it as `dispatchedBy`, and the
     * lead's policy decides on it: an unattended cause is refused unless the policy lists it.
     */
    origin: DispatchOrigin;
    /** Whether the user's personalization reaches the prompt — `"none"` when someone else reads the reply. */
    personalization: "full" | "none";
    /** Omitted when continuing a thread: its latest message is the prompt. */
    prompt?: string;
    /**
     * Asked after each step: `true` ends the loop there. The step that just
     * finished was run and is saved and billed; the step cap stays in force
     * alongside this (a stop condition given to the agent would replace it).
     */
    shouldStop?: () => Promise<boolean>;
    /** Instructions and run config, as a `/<slug>` invocation would contribute them. */
    skill?: { config?: SkillConfig; instructions: string };
    /** Appended to the agent's own instructions. */
    system?: string;
    /** A new thread, or an existing one to continue. */
    thread: { tags?: string[]; title: string } | { threadId: string };
    /**
     * Narrows the `"headless"` tool set to these names — a sub-agent's allowlist
     * (`sub-agents/`). It only removes: a name the set lacks stays absent.
     */
    toolAllowlist?: ReadonlyArray<string>;
    /**
     * With a {@link HeadlessRunOptions.toolAllowlist}: the user's MCP and
     * connector tools survive it (at `auto` only — the run is headless) instead
     * of being removed for not being named.
     */
    toolAllowlistKeepsMcp?: boolean;
    tools: "headless" | "none";
    /** The skill the usage page files this run under; absent = the plain assistant. */
    usageSkill?: ReplySkill;
    userId: string;
}

export interface HeadlessRunResult {
    /** What the gateway priced the run's steps at, summed; absent when no step carried a price. */
    costMicrodollars?: number;
    /** With {@link HeadlessRunOptions.goal}: how the goal ended. */
    goal?: Pick<HeadlessGoalOutcome, "ended" | "reason" | "rounds">;
    text: string;
    threadId: string;
    /** Tokens across every step, when the provider reported usage. */
    totalTokens?: number;
}

/** A skill's tool config merged with the caller's extra built-ins; `undefined` when neither says anything. */
const headlessSkillTools = (
    config: SkillConfig | undefined,
    additionalTools: ReadonlyArray<string> | undefined,
): { additionalTools?: string[]; disabledTools?: string[] } | undefined => {
    if (!config && !additionalTools?.length) {
        return undefined;
    }

    const extra = [...(config?.additionalTools ?? []), ...(additionalTools ?? [])];

    return { additionalTools: extra.length > 0 ? extra : undefined, disabledTools: config?.disabledTools };
};

export const runHeadlessAgent = async (ctx: ActionCtx, options: HeadlessRunOptions): Promise<HeadlessRunResult> => {
    const { model, prompt, skill, userId } = options;
    const { allowTools, customProvider } = await resolveRunModel(ctx, model, userId);
    const [prefs, userProviderKeys] = await Promise.all([
        ctx.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId }),
        loadUserProviderKeys(ctx, userId),
    ]);
    const extractMemory = options.memory && prefs.memoryEnabled;

    const toolResult =
        options.tools === "headless" && allowTools
            ? await buildAgentTools(ctx, {
                  headless: true,
                  ...(options.approvedTools && { headlessApproved: options.approvedTools }),
                  model,
                  searchMode: (skill?.config?.searchMode as SearchMode | undefined) ?? DEFAULT_HEADLESS_SEARCH_MODE,
                  skillTools: headlessSkillTools(skill?.config, options.additionalTools),
                  userId,
              })
            : { mcpClients: [], mcpLabels: {}, tools: {} };
    const toolAllowlist =
        options.toolAllowlist && options.toolAllowlistKeepsMcp ? [...options.toolAllowlist, ...Object.keys(toolResult.mcpLabels)] : options.toolAllowlist;

    try {
        setResearchDepth(ctx, "balanced");
        setDispatchOrigin(ctx, options.origin);

        const existingThreadId = "threadId" in options.thread ? options.thread.threadId : undefined;
        const personal = options.personalization === "full";
        const modelFilterRules = await loadModelFilterRules(ctx, userId);
        const backupModelId = await resolveBackupModelId(ctx, userId, prefs.backupModel, model, modelFilterRules);
        // The tools the call carries: after the allowlist, so a run it strips bare is sized for a backup that cannot call tools.
        const runTools = applyToolAllowlist(toolResult.tools, toolAllowlist);
        const agent = await getAgent(model, {
            backupModelId,
            customProvider,
            gateway: gatewayFetch(ctx),
            language: prefs.language,
            location: personal ? prefs.location : undefined,
            maxSteps: options.maxSteps ?? getMaxSteps(true),
            modelFilterRules,
            personalization: personal ? toPersonalization(prefs) : undefined,
            skillContext: skill ? { config: skill.config, instructions: skill.instructions } : undefined,
            threadId: existingThreadId,
            timezone: prefs.timezone,
            tools: runTools,
            userId,
            userProviderKeys,
        });

        const memoryContext = extractMemory && prompt ? await retrieveMemoryContext(ctx, userId, prompt, options.botId) : undefined;
        const extraParts = [options.system, memoryContext].filter((part): part is string => !!part);
        const generateArgs: Record<string, unknown> = {
            ...buildRunStreamArgs({
                backupModelId,
                hasTools: Object.keys(runTools).length > 0,
                model,
                reasoningEffort: skill?.config?.reasoningEffort,
                shouldAutoContinue: options.maxSteps === undefined,
            }),
            ...(prompt !== undefined && { prompt }),
            ...(options.shouldStop && { stopWhen: [stepCountIs(options.maxSteps ?? getMaxSteps(true)), stopWhenRequested(options.shouldStop)] }),
            // Without extra parts the agent falls back to its own instructions.
            ...(extraParts.length > 0 && { system: [agent.options.instructions, ...extraParts].filter(Boolean).join("\n\n") }),
        };

        let threadId: string;
        let thread;

        if (existingThreadId === undefined) {
            await options.beforeThread?.();

            // The tags go in with the insert, so a reader (a quiet routine's workspace check) never sees the thread untagged,
            // even while it runs or if the run fails.
            const created = await agent.createThread(ctx, {
                title: (options.thread as { title: string }).title,
                userId,
                ...("tags" in options.thread && options.thread.tags && { tags: options.thread.tags }),
            });

            threadId = created.threadId;
            thread = created.thread!;

            // As soon as the thread exists, so a failed bot patch below cannot leave it unrecorded.
            await options.onThread?.(threadId);

            // Before the run: a tool call reads `thread.botId` to find the bot's computer.
            if (options.botId) {
                await ctx.runMutation(internal.agent.threads.updateThread, {
                    patch: { botId: options.botId },
                    threadId: threadId as Id<"threads">,
                });
            }
        } else {
            threadId = existingThreadId;
            ({ thread } = await agent.continueThread(ctx, { threadId, userId }));
        }

        await options.onGenerationStart?.();

        const result = await thread.generateText(generateArgs as never);
        const text = result.text ?? "";

        await ctx.runMutation(internal.agent.threads.updateThread, {
            // A worker archived mid-run stays archived; every other run brings its thread back to active.
            patch: { ...(!options.keepThreadStatus && { status: "active" as const }), updatedAt: Date.now() },
            threadId: threadId as Id<"threads">,
        });

        if (extractMemory && text && prompt && servesUser(userId)) {
            void ctx.scheduler.runAfter(0, internal.memory.extract.extractMemories, {
                assistantResponse: text.slice(0, 4000),
                ...(options.botId && { botId: options.botId }),
                threadId: threadId as Id<"threads">,
                userId,
                userMessage: prompt,
            });
        }

        // Usage heatmap + per-skill breakdown, keyed on the reply's first row so a
        // redelivered record counts once. Every round of a goal is a reply of its own.
        const settle = (round: typeof result): GoalRoundResult & { priced: number | undefined } => {
            scheduleReplyUsage(
                ctx.scheduler as never,
                replyUsageArgs((round as { savedMessages?: ReadonlyArray<SavedRowLike> }).savedMessages ?? [], {
                    at: Date.now(),
                    userId,
                    ...(options.usageSkill && { skill: options.usageSkill }),
                    ...(prefs.timezone && { timeZone: prefs.timezone }),
                }),
            );

            const cost = sumMessageCosts((round.steps ?? []).map((step: { providerMetadata?: unknown }) => step.providerMetadata));

            return {
                costMicrodollars: cost?.microdollars ?? 0,
                priced: cost?.microdollars,
                text: round.text ?? "",
                totalTokens: round.totalUsage?.totalTokens ?? 0,
                transcript: stepsTranscript(round.steps ?? []),
            };
        };
        const first = settle(result);

        if (!options.goal) {
            return { costMicrodollars: first.priced, text, threadId, totalTokens: result.totalUsage?.totalTokens };
        }

        const goalText = options.goal.text;
        const outcome = await runHeadlessGoalRounds({
            charge: async () => await ctx.runMutation(internal.chat.goals.internal.chargeGoalRound, { userId }),
            first,
            goal: { ...options.goal },
            review: async ({ round, transcript }) => await reviewRound({ gateway: gatewayFetch(ctx), goal: goalText, round, threadId, transcript, userId }),
            runRound: async (instruction) => settle(await thread.generateText({ ...generateArgs, prompt: instruction } as never)),
            stopped: options.shouldStop,
        });

        return {
            costMicrodollars: outcome.costMicrodollars || undefined,
            goal: { ended: outcome.ended, reason: outcome.reason, rounds: outcome.rounds },
            text: outcome.result.text,
            threadId,
            totalTokens: outcome.totalTokens,
        };
    } finally {
        await closeMCPClients(toolResult.mcpClients);
    }
};
