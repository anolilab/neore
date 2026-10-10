/**
 * One user turn in a group chat: decide who speaks, then run each speaker as a
 * full agent run — that participant's instructions, model and tools — one after
 * the other into the SAME `persistentChunks` stream. A `speaker` marker chunk
 * opens each reply, so the client can say who is talking.
 *
 * Entry points, both called from `chat/execute.ts`:
 *
 * - `runGroupTurn` — a new user message in a group thread (`runStreamingAgent`).
 * - `continueGroupAfterToolApproval` — a participant paused on an `ask` tool;
 *   its snapshot names the participant and the speakers still queued, so the
 *   continuation resumes it and then lets the rest of the turn run.
 *
 * Cost is bounded by `MAX_SPEAKERS_PER_TURN` whatever the router or the
 * mentions asked for, plus one small routing call in supervisor mode. The
 * structured modes (`parallel`, `debate`) plan role-carrying steps instead,
 * bounded by `MAX_STEPS_PER_TURN`; their replies still run one after the other
 * into the one stream — "parallel" means independent (a speaker never sees the
 * others' answers to the same message), not concurrent. Every
 * model call goes through the gateway, so usage and billing are recorded per
 * speaker exactly as for a single-agent run.
 *
 * Speaker k > 1 continues from speaker k-1's last row with `forceNewOrder`, the
 * mechanism a tool-approval continuation uses: its reply is a new UI message on
 * the same branch, not a sibling of the first reply (which would read as a
 * regenerate).
 */
import type { MCPClient } from "@ai-sdk/mcp";
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { ModelMessage } from "ai";
import { generateText, Output } from "ai";
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import type { ResearchDepth } from "../../agent/client/create-tool";
import { streamLogger } from "../../lib/logger";
import { gatewayFetch, type ServiceFetch } from "../../lib/services";
import { getUtilityModel } from "../../lib/utility-model";
import { resolveReasoningEffort, resolveSkillModel } from "../../skills/slash-command";
import type { RunContext } from "../lib/agent-run";
import {
    afterRun,
    AgentRunError,
    buildRunStreamArgs,
    finishRun,
    loadRunContext,
    resolveRunModel,
    resumeApprovedRun,
    setResearchDepth,
    setThreadStatus,
    toResearchDepth,
} from "../lib/agent-run";
import { buildAgentTools } from "../lib/agent-tools";
import { getMaxSteps } from "../lib/auto-continue";
import getAgent from "../lib/get-agent";
import { closeMCPClients } from "../lib/mcp-tools";
import { pipeToPersistentChunks } from "../lib/persist-stream";
import type { SearchMode } from "../lib/tool-builder";
import type { ToolRunConfig } from "../lib/tool-run-config";
import type { GroupHistoryRow, GroupParticipantInfo } from "./logic";
import {
    buildGroupSystemContext,
    buildLabelledHistory,
    buildResumedHistory,
    buildRoleContext,
    buildRouterPrompt,
    enforceSpeakerCap,
    enforceStepCap,
    extractMentions,
    MAX_SPEAKERS_PER_TURN,
    nextRoundRobin,
    parseRoutingDecision,
    planTurn,
    remainingSpeakerBudget,
} from "./logic";
import type { GroupChatMode, GroupRunSnapshot, GroupStep } from "./validators";

/** The routing call is small; past this the turn falls back rather than stalls. */
const ROUTER_TIMEOUT_MS = 15_000;

interface GroupParticipantRun extends GroupParticipantInfo {
    config?: {
        additionalTools?: string[];
        disabledTools?: string[];
        preferredModel?: string;
        reasoningEffort?: number;
        searchMode?: string;
    };
    instructions: string;
}

export interface GroupRunConfig {
    debateRounds?: number;
    mode: GroupChatMode;
    participants: GroupParticipantRun[];
    stopRequestedAt?: number;
    synthesizerSkillId?: string;
}

/**
 * What a turn still has to run: bare speakers (supervisor, round-robin,
 * mention-only, and any `@mention`) or role-carrying steps (parallel, debate).
 */
type TurnQueue = { kind: "speakers"; queue: string[] } | { kind: "steps"; steps: GroupStep[] };

/** Where the queue stands when a speaker starts — recorded in its approval snapshot. */
interface QueuePosition {
    continueFromMessageId: string | undefined;
    /** The replies still planned after this one. */
    remaining: TurnQueue;
    spokenSkillIds: string[];
    /** This reply's role, in the structured modes. */
    step?: GroupStep;
}

/** The subset of `runStreamingAgent`'s input a group turn reads. */
export interface GroupTurnInput {
    isAnonymous: boolean;
    messageId: string;
    organizationId?: string;
    streamId: string;
    streamingConfig: {
        customSystemPrompt?: string;
        mcpServerNames?: string[];
        model: string;
        reasoningEffort?: number;
        researchDepth?: string;
        searchMode?: string;
        shouldAutoContinue?: boolean;
    };
    threadId: string;
    userId: string;
    userPrompt?: string;
}

/** What every speaker of one turn shares: the user's settings and the turn's extra context. */
interface TurnContext {
    agentPrefs: { autoMediaEnrichment?: boolean };
    baseModel: string;
    /** Memory, knowledge base, project and thread instructions — appended to each speaker's system prompt. */
    extraContext: string[];
    isAnonymous: boolean;
    mcpServerNames: string[] | undefined;
    organizationId: string | undefined;
    participants: GroupParticipantRun[];
    prefs: RunContext["prefs"];
    /** The user message the turn answers. */
    promptMessageId: string;
    /** Captured from the first speaker's context — the prompt with its attachments. */
    promptMessages: ModelMessage[] | undefined;
    reasoningEffort: { message?: number; thread?: number };
    researchDepth: ResearchDepth;
    searchMode: string;
    shouldAutoContinue: boolean;
    streamId: string;
    threadId: string;
    turnStartedAt: number;
    userId: string;
    userProviderKeys: RunContext["userProviderKeys"];
}

/** The participants' public face — never their instructions. */
const toInfo = (participants: ReadonlyArray<GroupParticipantRun>): GroupParticipantInfo[] =>
    participants.map(({ description, name, skillId, slug }) => {
        return { description, name, skillId, slug };
    });

const loadHistory = async (ctx: Pick<ActionCtx, "runQuery">, threadId: string, userId: string): Promise<GroupHistoryRow[]> =>
    await ctx.runQuery(internal.chat.group.functions.getGroupHistory, { threadId, userId });

/**
 * Ask the router who should answer. Any failure — timeout, unreadable output,
 * nobody picked — is an empty list; the caller falls back to the rotation.
 */
export const routeSpeakers = async (args: {
    /** The calling action's gateway binding. */
    gateway: ServiceFetch;
    history: ReadonlyArray<GroupHistoryRow>;
    participants: ReadonlyArray<GroupParticipantInfo>;
    threadId: string;
    userId: string;
}): Promise<string[]> => {
    const { gateway, history, participants, threadId, userId } = args;

    if (participants.length === 1) {
        return participants.map((p) => p.skillId);
    }

    try {
        const model = await getUtilityModel(gateway, { threadId, userId });
        const result = await generateText({
            abortSignal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
            model,
            output: Output.object({ schema: z.object({ speakers: z.array(z.string()) }) }),
            prompt: buildRouterPrompt({ cap: MAX_SPEAKERS_PER_TURN, history, participants }),
        });

        return parseRoutingDecision(result.output, participants);
    } catch (error) {
        streamLogger.warn("[GroupChat] Routing failed, falling back to rotation", error);

        return [];
    }
};

const lastSpeakerOf = (history: ReadonlyArray<GroupHistoryRow>): string | undefined =>
    history.findLast((row) => row.speakerSkillId !== undefined)?.speakerSkillId;

/**
 * Run ONE participant into the turn's stream. Returns whether it paused on a
 * tool approval (which ends the turn) and the id of its last saved row — where
 * the next speaker continues from.
 */
const runSpeaker = async (
    ctx: ActionCtx,
    turn: TurnContext,
    speaker: GroupParticipantRun,
    position: QueuePosition,
): Promise<{ lastMessageId: string | undefined; paused: boolean }> => {
    let mcpClients: MCPClient[] = [];

    try {
        const model = resolveSkillModel(turn.baseModel, speaker.config?.preferredModel, (id) => MODEL_LOOKUP.get(id), turn.isAnonymous);
        const searchMode = (speaker.config?.searchMode ?? turn.searchMode) as SearchMode;
        const { allowTools, customProvider } = await resolveRunModel(ctx, model, turn.userId);

        const toolResult = allowTools
            ? await buildAgentTools(ctx, {
                  autoMediaEnrichment: turn.agentPrefs.autoMediaEnrichment,
                  mcpServerNames: turn.mcpServerNames,
                  model,
                  searchMode,
                  skillTools: speaker.config ? { additionalTools: speaker.config.additionalTools, disabledTools: speaker.config.disabledTools } : undefined,
                  userId: turn.userId,
              })
            : { mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools: {} };

        mcpClients = toolResult.mcpClients;

        setResearchDepth(ctx, turn.researchDepth);

        const agent = await getAgent(model, {
            customProvider,
            gateway: gatewayFetch(ctx),
            language: turn.prefs.language,
            location: turn.prefs.location,
            maxSteps: getMaxSteps(turn.shouldAutoContinue),
            personalization: turn.prefs.personalization,
            searchMode,
            skillContext: { config: speaker.config, instructions: speaker.instructions },
            threadId: turn.threadId,
            timezone: turn.prefs.timezone,
            tools: toolResult.tools,
            userId: turn.userId,
            userProviderKeys: turn.userProviderKeys,
        });

        // Saved rows carry the participant's name from the first write.
        agent.options.name = speaker.name;

        const participants = toInfo(turn.participants);
        const isFirstSpeaker = position.continueFromMessageId === undefined;
        const independent = position.step?.role === "independent";

        // Every speaker reads the shared history labelled for ITSELF: its own
        // replies as `assistant`, everyone else's as named, data-wrapped input.
        agent.options.contextHandler = async (handlerCtx, { inputPrompt }) => {
            if (isFirstSpeaker && inputPrompt.length > 0) {
                turn.promptMessages = inputPrompt;
            }

            const rows = await loadHistory(handlerCtx, turn.threadId, turn.userId);

            return buildLabelledHistory(rows, speaker.skillId, turn.promptMessages ? { id: turn.promptMessageId, messages: turn.promptMessages } : undefined, {
                independent,
            });
        };

        const system = [
            agent.options.instructions ?? "",
            buildGroupSystemContext(speaker, participants),
            position.step ? buildRoleContext(position.step) : "",
            ...turn.extraContext,
        ]
            .filter(Boolean)
            .join("\n\n");
        const reasoningEffort = resolveReasoningEffort({
            messageEffort: turn.reasoningEffort.message,
            skillEffort: speaker.config?.reasoningEffort,
            threadEffort: turn.reasoningEffort.thread,
        });
        const streamTextArgs: Record<string, unknown> = {
            ...buildRunStreamArgs({ model, reasoningEffort, shouldAutoContinue: turn.shouldAutoContinue }),
            system,
            ...(isFirstSpeaker ? { promptMessageId: turn.promptMessageId } : { forceNewOrder: true, promptMessageId: position.continueFromMessageId }),
        };

        await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
            final: false,
            speaker: { name: speaker.name, skillId: speaker.skillId },
            streamId: turn.streamId as Id<"persistentStreams">,
            text: "",
        });

        const result = await agent.streamText(ctx, { threadId: turn.threadId, userId: turn.userId }, streamTextArgs as never, { saveStreamDeltas: false });
        const timingStart = Date.now();
        const { firstTokenTime, pending } = await pipeToPersistentChunks(ctx, turn.streamId, result.fullStream);

        await result.consumeStream();

        const savedIds = (result.savedMessages ?? []).map((m) => m._id as string);

        if (savedIds.length > 0) {
            await ctx.runMutation(internal.chat.group.functions.markSpeakerMessages, {
                agentName: speaker.name,
                messageIds: savedIds,
                skillId: speaker.skillId,
                threadId: turn.threadId,
                userId: turn.userId,
            });
        }

        const snapshot: ToolRunConfig = {
            autoMediaEnrichment: turn.agentPrefs.autoMediaEnrichment ?? false,
            group: groupSnapshot(turn, speaker.skillId, position),
            instructions: system,
            mcpServerNames: toolResult.mcpServerNames,
            model,
            reasoningEffort,
            researchDepth: turn.researchDepth,
            searchMode,
            shouldAutoContinue: turn.shouldAutoContinue,
            toolNames: Object.keys(toolResult.tools),
            toolPermissionKeys: toolResult.permissionKeys,
        };

        const { paused } = await finishRun(ctx, {
            keepOpenUnlessPaused: true,
            mcpLabels: toolResult.mcpLabels,
            pending,
            savedMessages: result.savedMessages,
            snapshot,
            streamId: turn.streamId,
            threadId: turn.threadId,
            userId: turn.userId,
        });

        // Timing only: memory is not extracted from group turns — the exchange
        // is several participants' voices, not the user talking to one assistant.
        afterRun(ctx, {
            extractMemory: false,
            firstTokenTime,
            prompt: "",
            savedMessages: result.savedMessages,
            skill: { id: speaker.skillId, name: speaker.name },
            threadId: turn.threadId,
            ...(turn.prefs.timezone && { timeZone: turn.prefs.timezone }),
            timingStart,
            userId: turn.userId,
        });

        return { lastMessageId: savedIds.at(-1), paused };
    } finally {
        await closeMCPClients(mcpClients);
    }
};

const groupSnapshot = (turn: TurnContext, skillId: string, position: QueuePosition): GroupRunSnapshot => {
    const { remaining } = position;

    return {
        baseModel: turn.baseModel,
        isAnonymous: turn.isAnonymous,
        ...(turn.organizationId && { organizationId: turn.organizationId }),
        queue: remaining.kind === "speakers" ? remaining.queue : remaining.steps.map((step) => step.skillId),
        skillId,
        spokenSkillIds: position.spokenSkillIds,
        ...(position.step && { step: position.step }),
        ...(remaining.kind === "steps" && { steps: remaining.steps }),
        turnStartedAt: turn.turnStartedAt,
    };
};

/**
 * The replies a turn may still run after `spoken`: speakers deduped against who
 * already spoke and cut to the speaker cap; steps cut to the step cap (a
 * debater speaks once per round, so steps are never deduped).
 */
const boundedQueue = (plan: TurnQueue, spoken: ReadonlyArray<string>): TurnQueue =>
    plan.kind === "steps"
        ? { kind: "steps", steps: enforceStepCap(plan.steps, spoken.length) }
        : {
              kind: "speakers",
              queue: enforceSpeakerCap(
                  plan.queue.filter((id) => !spoken.includes(id)),
                  remainingSpeakerBudget(spoken.length),
              ),
          };

/** Take the next reply off the queue: its speaker, its role, and what is left. */
const shiftQueue = (queue: TurnQueue): { next: { skillId: string; step?: GroupStep } | undefined; rest: TurnQueue } => {
    if (queue.kind === "steps") {
        const [step, ...steps] = queue.steps;

        return { next: step && { skillId: step.skillId, step }, rest: { kind: "steps", steps } };
    }

    const [skillId, ...rest] = queue.queue;

    return { next: skillId === undefined ? undefined : { skillId }, rest: { kind: "speakers", queue: rest } };
};

const isQueueEmpty = (queue: TurnQueue): boolean => (queue.kind === "steps" ? queue.steps : queue.queue).length === 0;

/**
 * Run `queue` in order until it is empty, the per-turn cap is reached, the
 * user pressed stop, or a speaker paused for an approval. Closes the stream
 * unless a pause already did.
 */
const runQueue = async (
    ctx: ActionCtx,
    turn: TurnContext,
    start: { continueFromMessageId: string | undefined; plan: TurnQueue; spokenSkillIds: string[] },
): Promise<void> => {
    const spoken = [...start.spokenSkillIds];
    let queue = boundedQueue(start.plan, spoken);
    let continueFrom = start.continueFromMessageId;

    while (!isQueueEmpty(queue)) {
        const { next, rest } = shiftQueue(queue);

        queue = rest;

        const speaker = next ? turn.participants.find((p) => p.skillId === next.skillId) : undefined;

        if (!next || !speaker) {
            continue;
        }

        // Checked between speakers: the one already talking always finishes.
        if (
            spoken.length > 0 &&
            (await ctx.runQuery(internal.chat.group.functions.isGroupStopRequested, { since: turn.turnStartedAt, threadId: turn.threadId }))
        ) {
            break;
        }

        // `/chat/start` charged the turn's first reply; each further one is a
        // full agent run of its own and costs one more unit of the daily quota.
        if (
            spoken.length > 0 &&
            !(await ctx.runMutation(internal.chat.daily_charge.chargeDailyUnit, { kind: "Text", organizationId: turn.organizationId, userId: turn.userId }))
        ) {
            streamLogger.debug("[GroupChat] Daily limit reached; ending the turn early", { spoken: spoken.length, threadId: turn.threadId });

            break;
        }

        spoken.push(speaker.skillId);

        const { lastMessageId, paused } = await runSpeaker(ctx, turn, speaker, {
            continueFromMessageId: continueFrom,
            remaining: queue,
            spokenSkillIds: spoken,
            ...(next.step && { step: next.step }),
        });

        if (paused) {
            // `finishRun` closed the stream; the approval's continuation picks up
            // this speaker and the rest of `queue` from the snapshot.
            return;
        }

        continueFrom = lastMessageId ?? continueFrom;
    }

    await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
        final: true,
        streamId: turn.streamId as Id<"persistentStreams">,
        text: "",
    });

    await setThreadStatus(ctx, turn.threadId, "active");

    void ctx.scheduler.runAfter(0, internal.chat.functions.generateFollowupSuggestionsForThread, { threadId: turn.threadId, userId: turn.userId });
};

/** Settings shared by every speaker; memory, knowledge base and project context are read once per turn. */
const loadTurnContext = async (
    ctx: ActionCtx,
    args: {
        baseModel: string;
        config: GroupRunConfig;
        customSystemPrompt?: string;
        isAnonymous: boolean;
        mcpServerNames?: string[];
        messageReasoningEffort?: number;
        organizationId?: string;
        promptMessageId: string;
        /** The user's message, for memory and knowledge-base retrieval — absent on a resumed turn. */
        promptText?: string;
        researchDepth: ResearchDepth;
        searchMode: string;
        shouldAutoContinue: boolean;
        streamId: string;
        threadId: string;
        turnStartedAt: number;
        userId: string;
    },
): Promise<TurnContext> => {
    const { threadId, userId } = args;
    const [agentPrefs, thread] = await Promise.all([
        ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId }),
        ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> }),
    ]);
    const runContext = await loadRunContext(ctx, {
        customSystemPrompt: args.customSystemPrompt,
        promptText: args.promptText,
        researchDepth: args.researchDepth,
        threadId,
        threadLanguage: thread?.language,
        userId,
    });

    return {
        agentPrefs,
        baseModel: args.baseModel,
        extraContext: runContext.contextParts,
        isAnonymous: args.isAnonymous,
        mcpServerNames: args.mcpServerNames,
        organizationId: args.organizationId,
        participants: args.config.participants,
        prefs: runContext.prefs,
        promptMessageId: args.promptMessageId,
        promptMessages: undefined,
        reasoningEffort: { message: args.messageReasoningEffort, thread: runContext.threadSettings?.reasoningEffort },
        researchDepth: runContext.researchDepth,
        searchMode: args.searchMode,
        shouldAutoContinue: args.shouldAutoContinue,
        streamId: args.streamId,
        threadId,
        turnStartedAt: args.turnStartedAt,
        userId,
        userProviderKeys: runContext.userProviderKeys,
    };
};

/**
 * A new user message in a group thread. Throws on failure; `runStreamingAgent`
 * owns the error handling and closes the stream.
 */
export const runGroupTurn = async (ctx: ActionCtx, input: GroupTurnInput, config: GroupRunConfig): Promise<void> => {
    const turnStartedAt = Date.now();
    const { messageId, streamingConfig, threadId, userId } = input;

    if (config.participants.length === 0) {
        throw new AgentRunError("skill", "None of this group's participants are available. Enable their skills in Settings, or change the participants.");
    }

    const [message] = await ctx.runQuery(internal.agent.messages.getMessagesByIds, { messageIds: [messageId as Id<"messages">] });
    const promptText = message?.text ?? "";
    const participants = toInfo(config.participants);

    const turn = await loadTurnContext(ctx, {
        baseModel: streamingConfig.model,
        config,
        customSystemPrompt: streamingConfig.customSystemPrompt,
        isAnonymous: input.isAnonymous,
        mcpServerNames: streamingConfig.mcpServerNames,
        messageReasoningEffort: streamingConfig.reasoningEffort,
        organizationId: input.organizationId,
        promptMessageId: messageId,
        promptText,
        researchDepth: toResearchDepth(streamingConfig.researchDepth),
        searchMode: streamingConfig.searchMode || "chat",
        shouldAutoContinue: streamingConfig.shouldAutoContinue === true,
        streamId: input.streamId,
        threadId,
        turnStartedAt,
        userId,
    });

    const history = await loadHistory(ctx, threadId, userId);
    const lastSpeaker = lastSpeakerOf(history);
    // Mentions come from what the user TYPED when the run has it — `message.text`
    // may lead with extracted attachment text.
    const mentions = extractMentions(input.userPrompt ?? promptText, participants);
    const plan = planTurn({
        debateRounds: config.debateRounds,
        lastSpeakerSkillId: lastSpeaker,
        mentions,
        mode: config.mode,
        participants,
        synthesizerSkillId: config.synthesizerSkillId,
    });

    if (plan.kind === "steps" && plan.steps.length > 0) {
        streamLogger.debug("[GroupChat] Turn planned", { mode: config.mode, planned: plan.steps.length, threadId });

        await runQueue(ctx, turn, { continueFromMessageId: undefined, plan, spokenSkillIds: [] });

        return;
    }

    // An empty structured plan (no participants left) falls through to the rotation below.
    let queue: string[] = [];

    if (plan.kind === "fixed") {
        queue = plan.speakers;
    } else if (plan.kind === "route") {
        queue = await routeSpeakers({ gateway: gatewayFetch(ctx), history, participants, threadId, userId });
    }

    if (queue.length === 0) {
        const fallback = nextRoundRobin(participants, lastSpeaker);

        queue = fallback ? [fallback] : [];
    }

    streamLogger.debug("[GroupChat] Turn planned", { mode: config.mode, planned: queue.length, threadId });

    await runQueue(ctx, turn, { continueFromMessageId: undefined, plan: { kind: "speakers", queue }, spokenSkillIds: [] });
};

/**
 * Resume a group turn whose participant paused on a tool approval: finish that
 * participant's run exactly as `continueAfterToolApproval` would, then run the
 * speakers still queued. Throws on failure; the caller closes the stream.
 */
export const continueGroupAfterToolApproval = async (
    ctx: ActionCtx,
    args: {
        answer?: string;
        approvalId: string;
        approved: boolean;
        config: ToolRunConfig & { group: GroupRunSnapshot };
        denyReason?: string;
        streamId: string;
        threadId: string;
        userId: string;
    },
): Promise<void> => {
    const { answer, approvalId, approved, config, denyReason, streamId, threadId, userId } = args;
    const { group } = config;

    // Participants are re-checked: one that lost access since the pause does
    // not get to finish, and nobody queued after it runs either.
    const groupConfig = (await ctx.runQuery(internal.chat.group.functions.getGroupRunConfig, {
        organizationId: group.organizationId,
        threadId,
        userId,
    })) as GroupRunConfig | null;
    const speaker = groupConfig?.participants.find((p) => p.skillId === group.skillId);

    if (!groupConfig || !speaker) {
        throw new AgentRunError("stale-approval", "Participant is no longer available");
    }

    const resumed = await resumeApprovedRun(
        ctx,
        { answer, approvalId, approved, config, denyReason, streamId, threadId, userId },
        {
            afterSaved: async ({ messageIds, toolResultId }) => {
                await ctx.runMutation(internal.chat.group.functions.markSpeakerMessages, {
                    agentName: speaker.name,
                    messageIds: toolResultId ? [toolResultId, ...messageIds] : messageIds,
                    skillId: speaker.skillId,
                    threadId,
                    userId,
                });
            },
            agentName: speaker.name,
            beforeStream: async () => {
                await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
                    final: false,
                    speaker: { name: speaker.name, skillId: speaker.skillId },
                    streamId: streamId as Id<"persistentStreams">,
                    text: "",
                });
            },
            // The resumed speaker reads the room exactly as it did before the
            // pause: other participants labelled and wrapped as data, its own
            // paused reply intact so the approved call can continue.
            contextHandler: async (handlerCtx, { existingResponses, inputMessages, inputPrompt, recent }) => {
                const rows = await loadHistory(handlerCtx, threadId, userId);

                return [
                    ...buildResumedHistory(rows, speaker.skillId, recent, { independent: group.step?.role === "independent" }),
                    ...inputMessages,
                    ...inputPrompt,
                    ...existingResponses,
                ];
            },
            keepOpenUnlessPaused: true,
        },
    );

    if (resumed.paused) {
        return;
    }

    const turn = await loadTurnContext(ctx, {
        baseModel: group.baseModel,
        config: groupConfig,
        isAnonymous: group.isAnonymous,
        mcpServerNames: config.mcpServerNames,
        organizationId: group.organizationId,
        promptMessageId: resumed.lastMessageId ?? approvalId,
        researchDepth: config.researchDepth,
        searchMode: config.searchMode,
        shouldAutoContinue: config.shouldAutoContinue,
        streamId,
        threadId,
        turnStartedAt: group.turnStartedAt,
        userId,
    });

    // Without a row to continue from, the next speaker would re-answer the
    // prompt as a sibling reply; closing the turn is the safe reading.
    const remaining: TurnQueue = group.steps ? { kind: "steps", steps: group.steps } : { kind: "speakers", queue: group.queue };

    await runQueue(ctx, turn, {
        continueFromMessageId: resumed.lastMessageId,
        plan: resumed.lastMessageId ? remaining : { kind: "speakers", queue: [] },
        spokenSkillIds: group.spokenSkillIds,
    });
};
