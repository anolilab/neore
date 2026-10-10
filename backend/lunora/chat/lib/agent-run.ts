/**
 * What every agent run shares, so the entry points cannot drift apart:
 *
 * - `chat/execute.ts` — `runStreamingAgent` (a fresh turn) and
 *   `continueAfterToolApproval` (the same run, resumed from its
 *   `toolApprovalRuns` snapshot);
 * - `chat/group/run.ts` — each group-chat speaker, and its resumption;
 * - `lib/headless-run.ts` (`runHeadlessAgent`) — triggers, tasks and messenger replies.
 *
 * Here: resolving the model's endpoint, the per-user context a run reads
 * (`loadRunContext`), the streamText arguments, the tail that records a pause
 * and flushes the stream, the post-run bookkeeping (`afterRun`), resuming an
 * approved run (`resumeApprovedRun`) and the error cleanup.
 */
import { MODEL_LOOKUP, parseCustomModelId, requiresPaidPlan } from "@neore/ai/models";
import type { UserPersonalization } from "@neore/ai/prompts";
import { buildMemoryContext } from "@neore/ai/prompts";

import { api } from "../../_generated/api";
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import type { ContextHandler } from "../../agent/client/types";
import type { ResearchDepth } from "../../agent/client/create-tool";
import type { MessageDoc } from "../../agent/validators";
import { streamLogger } from "../../lib/logger";
import { buildAgentTools } from "./agent-tools";
import { compressContextMessages, getMaxSteps, getModelContextWindow } from "./auto-continue";
import { isLocalBrowserProvider, toGatewayFormat } from "./custom-providers";
import type { GatewayCustomProviderConfig } from "./gateway-language-model";
import { gatewayFetch } from "../../lib/services";
import getAgent from "./get-agent";
import type { McpToolLabels } from "./mcp-tool-labels";
import { labelMcpToolCalls } from "./mcp-tool-labels";
import { closeMCPClients } from "./mcp-tools";
import { pipeToPersistentChunks } from "./persist-stream";
import { buildReasoningProviderOptions } from "./reasoning-options";
import { ASK_USER_TOOL_NAME } from "../tools/ask-user-constants";
import { collectApprovalRequestIds, collectAskUserApprovalIds } from "./tool-approval-claim";
import type { SearchMode } from "./tool-builder";
import type { ToolRunConfig } from "./tool-run-config";
import { callOnShard } from "../../lib/cross-shard";
import { servesUser } from "../../lib/shard-context";
import { runAfterOnShard } from "../../lib/shard-scheduler";
import { shouldNoteBriefActivity } from "../../notifications/daily-brief-logic";
import { buildKnowledgeCitations, type KnowledgeSource } from "../../knowledge/citations";
import type { ReplySkill } from "../../usage/activity-logic";
import { replyUsageArgs } from "../../usage/activity-logic";
import { scheduleReplyUsage } from "../../usage/schedule";

/** Registry providers carry an `internal-` prefix the provider-keyed options do not. */
export const INTERNAL_PREFIX_RE = /^internal-/;

/**
 * - `skill`: a skill that exists but cannot run (disabled, missing variables).
 *   Its message is ours and safe to show.
 * - `custom-endpoint`: a `custom:<providerId>/<modelId>` model whose endpoint
 *   was deleted or disabled.
 * - `local-endpoint`: a `local-browser` endpoint, which only the user's
 *   browser can reach. Its message is ours and safe to show.
 * - `stale-approval`: the approval a continuation was scheduled for is no
 *   longer answerable — the conversation moved on, or the tool is gone.
 * - `plan-required`: a model outside the free tier, asked for without a paid
 *   plan or the user's own key for its provider. Its message is ours and safe to show.
 */
export type AgentRunErrorKind = "custom-endpoint" | "local-endpoint" | "plan-required" | "skill" | "stale-approval";

/** A failure a run raised itself, so the catch branches on `kind` rather than on message text. */
export class AgentRunError extends Error {
    public readonly kind: AgentRunErrorKind;

    public constructor(kind: AgentRunErrorKind, message: string) {
        super(message);
        this.kind = kind;
        this.name = "AgentRunError";
    }
}

export const isAgentRunError = (error: unknown, kind: AgentRunErrorKind): error is AgentRunError => error instanceof AgentRunError && error.kind === kind;

export interface RunModel {
    /** Unknown models often reject tool definitions outright; a custom endpoint gets tools only when the user said it supports them. */
    allowTools: boolean;
    customProvider: GatewayCustomProviderConfig | undefined;
}

/**
 * `custom:<providerId>/<modelId>` — the user's own endpoint. Resolved up front
 * so a deleted/disabled endpoint fails loudly instead of silently falling back
 * to a platform model the user did not pick.
 */
/**
 * Refuses a model outside the free tier (`requiresPaidPlan`) unless the user is
 * on a paid plan, is an admin, or brings their own key for the model's provider
 * — the platform pays for every other run. Every run (chat, trigger, workflow,
 * group turn) resolves its model here, so this is the one gate.
 */
const assertModelAllowed = async (ctx: Pick<ActionCtx, "runQuery">, model: string, userId: string): Promise<void> => {
    const definition = MODEL_LOOKUP.get(model);

    if (!definition || !requiresPaidPlan(definition)) {
        return;
    }

    const [{ isAdmin, plan }, userProviderKeys] = await Promise.all([
        ctx.runQuery(internal.auth.functions.getUserRunPlanQuery, { userId }),
        loadUserProviderKeys(ctx, userId),
    ]);

    if (isAdmin || plan === "premium" || userProviderKeys?.[definition.provider]) {
        return;
    }

    throw new AgentRunError("plan-required", "This model needs a Pro plan. Pick a free model, upgrade, or add your own API key for this provider in Settings.");
};

export const resolveRunModel = async (ctx: Pick<ActionCtx, "runQuery">, model: string, userId: string): Promise<RunModel> => {
    const customModel = parseCustomModelId(model);

    if (!customModel) {
        await assertModelAllowed(ctx, model, userId);

        return { allowTools: true, customProvider: undefined };
    }

    const provider = await ctx.runQuery(internal.chat.custom_providers.getDecryptedCustomProvider, { providerId: customModel.providerId, userId });

    if (!provider) {
        throw new AgentRunError("custom-endpoint", "Custom endpoint missing or disabled");
    }

    // A loopback endpoint the user's browser calls — this server cannot reach it.
    if (isLocalBrowserProvider(provider.type)) {
        throw new AgentRunError("local-endpoint", "This model runs on your own computer and can only be used from the chat window in your browser");
    }

    return {
        allowTools: provider.supportsTools,
        customProvider: {
            ...(provider.accessKeyId && { accessKeyId: provider.accessKeyId }),
            apiKey: provider.apiKey,
            ...(provider.apiVersion && { apiVersion: provider.apiVersion }),
            baseUrl: provider.baseUrl,
            format: toGatewayFormat(provider.type),
            id: provider.id,
            ...(provider.region && { region: provider.region }),
        },
    };
};

/**
 * `researchDepth` arrives as a plain string; tools index their depth tables
 * with the `ResearchDepth` union, so an unknown value would read as `undefined`
 * inside `webSearch`/`deepResearch`.
 */
export const toResearchDepth = (value: string | undefined): ResearchDepth => (value === "speed" || value === "thorough" ? value : "balanced");

/** The agent forwards the action ctx to tools as their `ToolCtx`, which declares `researchDepth`; the action ctx has no such field. */
export const setResearchDepth = (ctx: object, researchDepth: ResearchDepth): void => {
    (ctx as { researchDepth?: ResearchDepth }).researchDepth = researchDepth;
};

/** Personalization only when the user set any of it; `undefined` otherwise, so the prompt carries no empty block. */
export const toPersonalization = (prefs: {
    aboutMe?: string;
    customInstructions?: string;
    nickname?: string;
    profession?: string;
}): UserPersonalization | undefined => {
    const { aboutMe, customInstructions, nickname, profession } = prefs;

    return nickname || profession || aboutMe || customInstructions ? { aboutMe, customInstructions, nickname, profession } : undefined;
};

/** The user's own provider keys, or `undefined` when they set none. */
export const loadUserProviderKeys = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<Record<string, string> | undefined> => {
    const keys = await ctx.runQuery(internal.auth.functions.getDecryptedProviderKeysQuery, { userId });

    return Object.keys(keys).length > 0 ? keys : undefined;
};

/** At most this much of the prompt is embedded for memory and knowledge-base retrieval. */
const RETRIEVAL_TEXT_LENGTH = 2000;

/** A memory injected into a reply's prompt — recorded on the reply for the "why was this used" view. */
export type RetrievedMemoryRef = { memoryId: string; score: number };

/** The memory block for the system prompt, and which memories went into it. */
const retrieveMemories = async (
    ctx: Pick<ActionCtx, "runAction">,
    userId: string,
    searchText: string,
): Promise<{ context: string | undefined; refs: RetrievedMemoryRef[] }> => {
    try {
        // A turn in a thread someone shared runs on THEIR shard, and this user's
        // memories live on their own — read there (`servesUser`). Only the
        // caller's own memories, for the caller's own turn: no wider access.
        const memories = servesUser(userId)
            ? await ctx.runAction(internal.memory.retrieve.retrieveRelevantMemories, { searchText, userId })
            : await callOnShard(internal.memory.retrieve.retrieveRelevantMemories, { searchText, userId }, { shardKey: userId });

        return {
            context: memories.length > 0 ? buildMemoryContext(memories) : undefined,
            refs: memories.map(({ memoryId, score }) => {
                return { memoryId, score };
            }),
        };
    } catch (error) {
        streamLogger.warn("[AgentRun] Memory retrieval failed:", error);

        return { context: undefined, refs: [] };
    }
};

export const retrieveMemoryContext = async (ctx: Pick<ActionCtx, "runAction">, userId: string, searchText: string): Promise<string | undefined> => {
    const { context } = await retrieveMemories(ctx, userId, searchText);

    return context;
};

/**
 * Knowledge-base excerpts for the prompt, numbered for citation, and the
 * `source` documents that back the numbers (`knowledge/citations.ts`).
 */
const retrieveKnowledgeContext = async (
    ctx: Pick<ActionCtx, "runAction">,
    args: { query: string; threadId: string; userId: string },
): Promise<{ context: string | undefined; sources: KnowledgeSource[] }> => {
    try {
        return buildKnowledgeCitations(await ctx.runAction(internal.knowledge.retrieve.search, args));
    } catch (error) {
        streamLogger.warn("[AgentRun] Knowledge base retrieval failed:", error);

        return { context: undefined, sources: [] };
    }
};

/**
 * The per-user context an interactive run reads before it starts: preferences
 * and personalization, the thread's settings, the user's provider keys, and the
 * extra system-prompt context — relevant memories, knowledge-base excerpts,
 * the project's context and the thread's own instructions.
 *
 * Retrieval runs only for a non-empty `promptText` (a resumed group turn has
 * none). `customSystemPrompt` is the request's; the thread's setting wins.
 */
export const loadRunContext = async (
    ctx: Pick<ActionCtx, "runAction" | "runQuery">,
    args: {
        customSystemPrompt?: string;
        promptText?: string;
        researchDepth?: string;
        threadId: string;
        threadLanguage?: string;
        userId: string;
    },
) => {
    const { threadId, userId } = args;
    const retrievalText = args.promptText?.slice(0, RETRIEVAL_TEXT_LENGTH);
    // This is on the wait for the first token, so nothing waits on a read it
    // does not use: the knowledge base needs neither preferences nor settings
    // and starts at once, memory waits only for the opt-in in the preferences,
    // and the project only for the thread settings that name it.
    const prefsPromise = ctx.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });
    const threadSettingsPromise = ctx.runQuery(internal.chat.functions.getThreadSettings, { threadId });
    const [prefs, threadSettings, userProviderKeys, memoryContext, knowledgeContext, project] = await Promise.all([
        prefsPromise,
        threadSettingsPromise,
        loadUserProviderKeys(ctx, userId),
        prefsPromise.then(async (loaded) => (loaded.memoryEnabled && retrievalText ? await retrieveMemories(ctx, userId, retrievalText) : undefined)),
        retrievalText ? retrieveKnowledgeContext(ctx, { query: retrievalText, threadId, userId }) : undefined,
        threadSettingsPromise.then(async (settings) =>
            settings?.projectId ? await ctx.runQuery(api.agent.projects.getProject, { projectId: settings.projectId as Id<"projects"> }) : null,
        ),
    ]);

    const customSystemPrompt = threadSettings?.customSystemPrompt ?? args.customSystemPrompt;
    const contextParts: string[] = [];

    if (memoryContext?.context) {
        contextParts.push(memoryContext.context);
    }

    if (knowledgeContext?.context) {
        contextParts.push(knowledgeContext.context);
    }

    if (project?.context) {
        contextParts.push(`PROJECT CONTEXT:\n${project.context}`);
    }

    if (customSystemPrompt) {
        contextParts.push(`ADDITIONAL INSTRUCTIONS:\n${customSystemPrompt}`);
    }

    return {
        /** Appended to the agent's instructions, in this order. */
        contextParts,
        /** The passages behind the `[n]` citations; `afterRun` records them on the reply. */
        knowledgeSources: knowledgeContext?.sources ?? [],
        memoryEnabled: prefs.memoryEnabled,
        prefs: {
            language: args.threadLanguage || prefs.language,
            location: prefs.location,
            personalization: toPersonalization(prefs),
            timezone: prefs.timezone,
        },
        researchDepth: toResearchDepth(args.researchDepth),
        /** Memories injected above; `afterRun` records them on the reply. */
        retrievedMemories: memoryContext?.refs ?? [],
        threadSettings,
        userProviderKeys,
    };
};

export type RunContext = Awaited<ReturnType<typeof loadRunContext>>;

/** A saved tool result, cut down for memory extraction. */
const summariseToolResults = (savedMessages: ReadonlyArray<MessageDoc>): { summary: string; toolName: string }[] => {
    const toolResults: { summary: string; toolName: string }[] = [];

    for (const savedMessage of savedMessages) {
        if (!savedMessage.tool || savedMessage.message?.role !== "tool" || !Array.isArray(savedMessage.message.content)) {
            continue;
        }

        for (const part of savedMessage.message.content) {
            if (part.type !== "tool-result") {
                continue;
            }

            // A persisted tool-result part carries a discriminated `output`
            // (see `normalizeToolResult` in agent/mapping.ts). There is no
            // `content` field on it.
            const { output } = part;
            let resultText = "";

            if (output?.type === "text" || output?.type === "error-text") {
                resultText = output.value;
            } else if (output?.type === "content") {
                resultText = output.value.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ");
            }

            if (part.toolName && resultText.length > 20) {
                toolResults.push({ summary: resultText.slice(0, 500), toolName: part.toolName });
            }
        }
    }

    return toolResults;
};

/**
 * Bookkeeping after a streamed run, fire-and-forget: the reply's timing, the
 * memories its prompt carried, and — when `extractMemory` is set — memory
 * extraction from the exchange plus the activity stamp nightly reflection
 * schedules from (`memory/reflection.ts`). Billing is not here; the LLM Gateway
 * usage webhook owns it.
 */
export const afterRun = (
    ctx: Pick<ActionCtx, "runMutation" | "scheduler">,
    args: {
        extractMemory: boolean;
        firstTokenTime: number | undefined;
        /** From `loadRunContext`; recorded on the reply's first row as citation sources. */
        knowledgeSources?: ReadonlyArray<KnowledgeSource>;
        prompt: string;
        /** From `loadRunContext`; recorded on the reply's first row, the id its UI message carries. */
        retrievedMemories?: ReadonlyArray<RetrievedMemoryRef>;
        savedMessages: ReadonlyArray<MessageDoc> | undefined;
        /** The skill that answered, for the usage page's per-skill breakdown; absent for the plain assistant. */
        skill?: ReplySkill;
        threadId: string;
        /** The user's IANA zone, so the usage heatmap files the reply under their calendar day. */
        timeZone?: string;
        timingStart: number;
        userId: string;
    },
): void => {
    const { firstTokenTime, prompt, savedMessages = [], threadId, timingStart, userId } = args;
    const lastAssistantMessage = savedMessages.findLast((m) => !m.tool);

    if (lastAssistantMessage) {
        void ctx.runMutation(internal.agent.messages.patchMessageTiming, {
            durationMs: Date.now() - timingStart,
            messageId: lastAssistantMessage._id as Id<"messages">,
            ...(firstTokenTime !== undefined && { ttftMs: firstTokenTime - timingStart }),
        });
    }

    const firstReplyRow = savedMessages.find((m) => m.message?.role !== "user");

    // The citation chips behind the reply's `[n]`. Messages live on the thread's
    // shard, which is where this runs.
    if (firstReplyRow && args.knowledgeSources && args.knowledgeSources.length > 0) {
        void ctx.scheduler.runAfter(0, internal.knowledge.functions.recordKnowledgeSources, {
            messageId: firstReplyRow._id as Id<"messages">,
            sources: [...args.knowledgeSources],
        });
    }

    // The "memories used" popover reads the memory rows on the THREAD's shard;
    // a collaborator's memories are on their own, so theirs are not recorded.
    if (firstReplyRow && args.retrievedMemories && args.retrievedMemories.length > 0 && servesUser(userId)) {
        void ctx.scheduler.runAfter(0, internal.memory.functions.recordRetrievedMemories, {
            memories: [...args.retrievedMemories],
            messageId: firstReplyRow._id as Id<"messages">,
            userId,
        });
    }

    // Daily Brief (`notifications/daily-brief.ts`): activity keeps the next
    // morning's run scheduled for users who opted in. Throttled per isolate — the
    // job is a no-op read for everyone else, and scheduling it on every reply
    // would put one job per reply on the user's lane.
    if (servesUser(userId) && shouldNoteBriefActivity(userId)) {
        void ctx.scheduler.runAfter(0, internal.notifications.daily_brief.noteDailyBriefActivity, { userId });
    }

    // Usage heatmap + per-skill breakdown (`usage/activity.ts`), on the user's own shard.
    scheduleReplyUsage(
        ctx.scheduler as never,
        replyUsageArgs(savedMessages, { at: Date.now(), userId, ...(args.skill && { skill: args.skill }), ...(args.timeZone && { timeZone: args.timeZone }) }),
    );

    if (!args.extractMemory || !prompt) {
        return;
    }

    // Memory is the USER's: in a thread someone shared, the extraction runs on
    // the collaborator's own shard, not the owner's this turn ran on.
    const memoryShard = servesUser(userId) ? undefined : userId;
    const scheduleMemory = async <A extends Record<string, unknown>>(target: { __lunoraRef: string }, jobArgs: A): Promise<string> =>
        memoryShard === undefined
            ? await ctx.scheduler.runAfter(0, target as never, jobArgs as never)
            : await runAfterOnShard(ctx.scheduler, 0, target, jobArgs, memoryShard);

    void scheduleMemory(internal.memory.reflection.noteMemoryActivity, { userId });

    const assistantText = savedMessages
        .filter((m) => !m.tool && m.message?.role === "assistant")
        .map((m) => (typeof m.message?.content === "string" ? m.message.content : ""))
        .filter(Boolean)
        .join("\n");

    if (assistantText.length === 0) {
        return;
    }

    const toolResults = summariseToolResults(savedMessages);

    void scheduleMemory(internal.memory.extract.extractMemories, {
        assistantResponse: assistantText.slice(0, 4000),
        threadId: threadId as Id<"threads">,
        userId,
        userMessage: prompt,
        ...(toolResults.length > 0 && { toolResults: toolResults.slice(0, 10) }),
    });
};

/**
 * The streamText arguments every run shares: provider-keyed reasoning options
 * and, for auto-continue, context compression between steps. Callers add their
 * own prompt / system fields on top.
 */
export const buildRunStreamArgs = (options: { model: string; reasoningEffort: number | undefined; shouldAutoContinue: boolean }): Record<string, unknown> => {
    const { model, reasoningEffort, shouldAutoContinue } = options;
    const modelDefinition = MODEL_LOOKUP.get(model);
    const supportsReasoningEffort =
        modelDefinition?.filterCapabilities?.includes("effort_control") || modelDefinition?.filterCapabilities?.includes("reasoning");

    // Provider-keyed, because that is what the AI SDK and the gateway's
    // `filterProviderOptions` index. See `reasoning-options.ts` for the three
    // separate reasons the previous flat bag never reached a provider.
    const providerOptions = buildReasoningProviderOptions(
        reasoningEffort,
        modelDefinition?.provider?.replace(INTERNAL_PREFIX_RE, "") || "",
        supportsReasoningEffort,
    );

    // `enabledFeatures` is not a provider option and never was: no provider
    // allowlists it, so nesting it under one would only get it stripped.
    const streamTextArgs: Record<string, unknown> = providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {};

    if (shouldAutoContinue) {
        const contextLimit = getModelContextWindow(model);

        streamTextArgs.prepareStep = ({ messages }: { messages: unknown[] }) => {
            const compressed = compressContextMessages(messages as never, contextLimit);

            return compressed === messages ? undefined : { messages: compressed };
        };
    }

    return streamTextArgs;
};

/**
 * The end of a streamed run, in order: MCP tool calls are labelled with their
 * real server and tool (`lib/mcp-tool-labels.ts`), a run that paused on `ask`
 * tools records a snapshot of itself per approval BEFORE the stream closes
 * (without it `respondToToolApproval` fails closed), then the remaining text is
 * flushed and the stream marked done.
 *
 * `keepOpenUnlessPaused` is for a group-chat turn with more speakers to come:
 * the text is flushed but the stream stays open — unless this speaker paused
 * for an approval, which ends the turn. Returns whether it paused.
 */
export const finishRun = async (
    ctx: Pick<ActionCtx, "runMutation">,
    args: {
        keepOpenUnlessPaused?: boolean;
        mcpLabels: McpToolLabels;
        pending: { reasoning: string; text: string };
        savedMessages: ReadonlyArray<{ _id: string; message?: { content?: unknown; role?: string } }> | undefined;
        snapshot: ToolRunConfig;
        streamId: string;
        threadId: string;
        userId: string;
    },
): Promise<{ paused: boolean }> => {
    const { keepOpenUnlessPaused, mcpLabels, pending, savedMessages, snapshot, streamId, threadId, userId } = args;
    const labelledIds = (savedMessages ?? []).flatMap((m) => (labelMcpToolCalls(m.message?.content, mcpLabels) ? [m._id] : []));

    if (labelledIds.length > 0) {
        await ctx.runMutation(internal.chat.mcp_tool_labels.labelToolCalls, { labels: mcpLabels, messageIds: labelledIds, userId });
    }

    const approvalIds = collectApprovalRequestIds(savedMessages);

    if (approvalIds.length > 0) {
        const askUserApprovalIds = collectAskUserApprovalIds(savedMessages, ASK_USER_TOOL_NAME);

        await ctx.runMutation(internal.chat.tool_permissions.recordPendingToolApprovals, {
            approvalIds,
            ...(askUserApprovalIds.length > 0 && { askUserApprovalIds }),
            config: snapshot,
            threadId,
            userId,
        });
    }

    const paused = approvalIds.length > 0;

    await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
        final: paused || keepOpenUnlessPaused !== true,
        reasoning: pending.reasoning || undefined,
        streamId: streamId as Id<"persistentStreams">,
        text: pending.text,
    });

    return { paused };
};

/**
 * Resume a run that paused on a tool-approval request: rebuild it from its
 * snapshot, check the approval is still the open one, let the agent execute
 * (or deny) the call and pipe the continuation into the stream.
 *
 * The rebuild uses the same servers and never more than the same tools; the
 * user's CURRENT permissions still apply, so a tool switched off since the
 * pause stays off. The system prompt is the paused run's FINAL one
 * (personalisation, memory, project and custom instructions included), not a
 * re-derived one.
 *
 * - `agentName`: the name saved rows carry (a group participant).
 * - `beforeStream`: runs once the approval is confirmed, before any text.
 * - `afterSaved`: the continuation's saved row ids, plus the tool-result row the
 *   agent saved before it (not among `savedMessages`; the first continuation
 *   row names it as its branch parent).
 * - `contextHandler`: replaces the agent's default context.
 * - `keepOpenUnlessPaused`: as for {@link finishRun}.
 */
export const resumeApprovedRun = async (
    ctx: ActionCtx,
    args: {
        /** An approved `askUser` call's answer: the resumed tool returns it as its result. */
        answer?: string;
        approvalId: string;
        approved: boolean;
        config: ToolRunConfig;
        /** Passed to a denied call instead of the default denial reason. */
        denyReason?: string;
        streamId: string;
        threadId: string;
        userId: string;
    },
    options: {
        afterSaved?: (saved: { messageIds: string[]; toolResultId: string | undefined }) => Promise<void>;
        agentName?: string;
        beforeStream?: () => Promise<void>;
        contextHandler?: ContextHandler;
        keepOpenUnlessPaused?: boolean;
    } = {},
): Promise<{ lastMessageId: string | undefined; paused: boolean }> => {
    const { answer, approvalId, approved, config, denyReason, streamId, threadId, userId } = args;
    const { customProvider } = await resolveRunModel(ctx, config.model, userId);
    const [toolResult, userProviderKeys] = await Promise.all([
        buildAgentTools(ctx, {
            autoMediaEnrichment: config.autoMediaEnrichment,
            // A person just answered in the chat, so this run is interactive.
            deviceThreadId: threadId,
            model: config.model,
            searchMode: config.searchMode as SearchMode,
            snapshot: { mcpServerNames: config.mcpServerNames, toolNames: config.toolNames },
            userId,
        }),
        loadUserProviderKeys(ctx, userId),
    ]);

    try {
        // Checked against our own state rather than inferred from the agent
        // library's error text: the request must still be the open one on the
        // latest turn, and an approved tool must still be in the rebuilt set.
        const pending = await ctx.runQuery(internal.chat.tool_permissions.getPendingToolApproval, { approvalId, threadId, userId });

        if (!pending) {
            throw new AgentRunError("stale-approval", "Approval is no longer pending on the latest turn");
        }

        if (approved && pending.toolName !== null && !Object.hasOwn(toolResult.tools, pending.toolName)) {
            throw new AgentRunError("stale-approval", `Tool ${pending.toolName} is no longer available`);
        }

        // An answered question: the approved call executes a copy of the tool
        // that returns the answer, so the answer is the call's tool result.
        if (approved && pending.toolName === ASK_USER_TOOL_NAME) {
            if (answer === undefined) {
                throw new AgentRunError("stale-approval", "A question can only be resumed with an answer");
            }

            // Loaded here, not at the top: the tool module pulls in the agent client.
            const { createAnsweredAskUserTool } = await import("../tools/ask-user");

            toolResult.tools[ASK_USER_TOOL_NAME] = createAnsweredAskUserTool(answer) as (typeof toolResult.tools)[string];
        }

        const agent = await getAgent(config.model, {
            customProvider,
            gateway: gatewayFetch(ctx),
            maxSteps: getMaxSteps(config.shouldAutoContinue),
            threadId,
            tools: toolResult.tools,
            userId,
            userProviderKeys,
        });

        if (options.agentName !== undefined) {
            agent.options.name = options.agentName;
        }

        // Set on the agent rather than passed per call, so both paths share it.
        if (config.instructions !== undefined) {
            agent.options.instructions = config.instructions;
        }

        if (options.contextHandler) {
            agent.options.contextHandler = options.contextHandler;
        }

        setResearchDepth(ctx, config.researchDepth);

        const streamTextArgs = buildRunStreamArgs({
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            shouldAutoContinue: config.shouldAutoContinue,
        });

        await options.beforeStream?.();

        const result = approved
            ? await agent.approveToolCall(ctx, { threadId, userId }, { approvalId }, streamTextArgs as never, { saveStreamDeltas: false })
            : await agent.denyToolCall(ctx, { approvalId, ...(denyReason !== undefined && { reason: denyReason }), threadId }, streamTextArgs as never, {
                  saveStreamDeltas: false,
              });
        const { pending: piped } = await pipeToPersistentChunks(ctx, streamId, result.fullStream);

        await result.consumeStream();

        const messageIds = (result.savedMessages ?? []).map((m) => m._id as string);

        if (messageIds.length > 0) {
            await options.afterSaved?.({
                messageIds,
                toolResultId: (result.savedMessages?.[0] as { parentMessageId?: string } | undefined)?.parentMessageId,
            });
        }

        // Paused again: the next approval inherits this snapshot unchanged.
        const { paused } = await finishRun(ctx, {
            keepOpenUnlessPaused: options.keepOpenUnlessPaused,
            mcpLabels: toolResult.mcpLabels,
            pending: piped,
            savedMessages: result.savedMessages,
            snapshot: config,
            streamId,
            threadId,
            userId,
        });

        return { lastMessageId: messageIds.at(-1), paused };
    } finally {
        await closeMCPClients(toolResult.mcpClients);
    }
};

export const setThreadStatus = async (ctx: Pick<ActionCtx, "runMutation">, threadId: string, status: "active" | "error"): Promise<void> => {
    await ctx.runMutation(internal.agent.threads.updateThread, {
        patch: { status, updatedAt: Date.now() },
        threadId: threadId as Id<"threads">,
    });
};

/**
 * Close a failed run: the (already sanitised) message goes to the stream so the
 * gateway can relay it — or, if even that fails, the stream is marked errored —
 * and the thread leaves `running`.
 */
export const failRun = async (
    ctx: Pick<ActionCtx, "runMutation">,
    args: { safeMessage: string; streamId: string; threadId: string; threadStatus: "active" | "error" },
): Promise<void> => {
    const { safeMessage, streamId, threadId, threadStatus } = args;

    try {
        await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
            final: true,
            streamId: streamId as Id<"persistentStreams">,
            text: `\n\nError: ${safeMessage}`,
        });
    } catch {
        await ctx.runMutation(internal.chat.streaming.persistent.library.setStreamStatus, {
            status: "error",
            streamId: streamId as Id<"persistentStreams">,
        });
    }

    try {
        await setThreadStatus(ctx, threadId, threadStatus);
    } catch {
        // Ignore cleanup errors
    }
};
