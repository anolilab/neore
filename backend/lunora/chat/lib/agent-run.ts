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
import { MODEL_LOOKUP, type ModelDefinition, type ModelFilterRules, parseCustomModelId } from "@neore/ai/models";
import type { UserPersonalization } from "@neore/ai/prompts";
import { buildMemoryContext } from "@neore/ai/prompts";

import { api } from "../../_generated/api";
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import type { ContextHandler, TakeSteer } from "../../agent/client/types";
import type { ResearchDepth } from "../../agent/client/create-tool";
import { lastRowOf, SUMMARY_IDLE_MS, SUMMARY_MIN_ORDER } from "../../agent/thread-summary-logic";
import type { MessageDoc } from "../../agent/validators";
import { streamLogger } from "../../lib/logger";
import { buildAgentTools } from "./agent-tools";
import { backupCanServe, backupCapabilities, backupFilterRejection, eligibleBackupModel, supportsBackupFallback } from "./backup-model";
import { allowsPaidModel, byokPaysFor, paidModelRefusal } from "./paid-model";
import { compressContextMessages, getFallbackContextWindow, getMaxSteps } from "./auto-continue";
import { isLocalBrowserProvider, toGatewayFormat } from "./custom-providers";
import type { GatewayCustomProviderConfig } from "./gateway-language-model";
import { gatewayFetch } from "../../lib/services";
import getAgent from "./get-agent";
import type { AutoApprovals } from "./low-risk-approval";
import { injectsUntrustedContext } from "./low-risk-approval";
import type { McpToolLabels } from "./mcp-tool-labels";
import { labelMcpToolCalls } from "./mcp-tool-labels";
import { closeMCPClients } from "./mcp-tools";
import { scheduleRepliesUsage } from "./pause-usage";
import {
    asRefusedWrite,
    isStreamWriteRefused,
    originalWriteError,
    pipeToPersistentChunks,
    type PipedStream,
    type StreamText,
    stopWhenStopped,
    toolProgressSink,
} from "./persist-stream";
import { buildReasoningProviderOptions } from "./reasoning-options";
import { ASK_USER_TOOL_NAME } from "../tools/ask-user-constants";
import { REQUEST_SECRET_TOOL_NAME } from "../tools/request-secret-constants";
import { collectApprovalRequestIds, collectAskUserApprovalIds } from "./tool-approval-claim";
import type { SearchMode } from "./tool-builder";
import type { ToolRunConfig } from "./tool-run-config";
import { ActionCache } from "../../lib/action-cache";
import { callOnShard } from "../../lib/cross-shard";
import { servesUser } from "../../lib/shard-context";
import { runAfterOnShard } from "../../lib/shard-scheduler";
import { shouldNoteBriefActivity } from "../../notifications/daily-brief-logic";
import { buildKnowledgeCitations, type KnowledgeSource } from "../../knowledge/citations";
import type { ReplySkill } from "../../usage/activity-logic";
import type { DispatchOrigin } from "../../sub-agents/logic";

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
/** What a run's gate reads of the user's plan: admins run any model, and a paid tier opens the paid ones. */
export interface RunPlan {
    isAdmin: boolean;
    plan: "premium" | null;
}

/**
 * The plan a run is gated on. Omit `organizationId` for the user's plan in ANY organization they belong
 * to (a run with no session, such as a trigger). Pass one for the run's own account: its tier when the
 * user is still a member, the user's own Pro otherwise, `null` for a personal run.
 */
export const readRunPlan = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, organizationId?: string | null): Promise<RunPlan> =>
    organizationId === undefined
        ? await ctx.runQuery(internal.auth.functions.getUserRunPlanQuery, { userId })
        : await ctx.runQuery(internal.auth.billing.getRunPlanForOrganizationQuery, { organizationId, userId });

/**
 * Whether a run may use `definition`: the one paid-model rule, for every run path. A model outside the
 * free tier (`requiresPaidPlan`) needs an admin, a paid plan, or the user's own key for the provider.
 *
 * A key exempts only where `byokPaysFor` says the user's key pays for the call. `plan` is the run's
 * pre-resolved plan (see `readRunPlan`).
 */
export const canRunPaidModel = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, definition: ModelDefinition, plan?: RunPlan): Promise<boolean> =>
    await allowsPaidModel(
        definition,
        async () => plan ?? (await readRunPlan(ctx, userId)),
        async () => {
            const keys = await loadUserProviderKeys(ctx, userId);

            return Boolean(keys?.[definition.provider]);
        },
    );

/** Refuses a paid-plan model for a run that cannot pay for it (`canRunPaidModel`). Every run resolves its model here. */
const assertModelAllowed = async (ctx: Pick<ActionCtx, "runQuery">, model: string, userId: string): Promise<void> => {
    const definition = MODEL_LOOKUP.get(model);

    if (!definition || (await canRunPaidModel(ctx, userId, definition))) {
        return;
    }

    throw new AgentRunError("plan-required", paidModelRefusal(definition.name ?? definition.id, byokPaysFor(definition)));
};

/**
 * The user's model filters (`{}` when they set none), for a run to read once and hand to both the gateway models
 * (`getAgent({ modelFilterRules })`, which is where `requireZDR` / `denyDataCollection` reach the provider routing)
 * and `resolveBackupModelId`. Every run path loads them here, so the chosen model and its backup are routed alike.
 */
export const loadModelFilterRules = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<ModelFilterRules> => {
    const preferences = await ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId });

    return preferences?.modelFilterRules ?? {};
};

/**
 * The user's backup model for a run on `model` (`FallbackLanguageModel`), or `undefined`: none set, a stale id,
 * the run's own model, or one the user's plan cannot run — a backup must not open a paid model the run's own
 * gate (`canRunPaidModel`) would refuse.
 */
export const resolveBackupModelId = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string,
    backupModel: string | undefined,
    model: string,
    filterRules?: ModelFilterRules,
): Promise<string | undefined> => {
    const definition = supportsBackupFallback(model) ? eligibleBackupModel(backupModel, model) : undefined;

    if (!definition) {
        return undefined;
    }

    // The caller may already hold the rules (the interactive run reads them for the gateway); every other path loads them here,
    // since the filters can encode privacy rules (regions, providers) that a backup must honour as much as the chosen model.
    const rules = filterRules ?? (await loadModelFilterRules(ctx, userId));

    if (backupFilterRejection(definition, rules) !== null) {
        return undefined;
    }

    return (await canRunPaidModel(ctx, userId, definition)) ? definition.id : undefined;
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

/** The agent forwards the action ctx to tools as their `ToolCtx`, which declares `dispatchOrigin`; the action ctx has no such field. */
export const setDispatchOrigin = (ctx: object, origin: DispatchOrigin): void => {
    (ctx as { dispatchOrigin?: DispatchOrigin }).dispatchOrigin = origin;
};

/** The agent forwards the action ctx to tools as their `ToolCtx`, which declares `headless`; the action ctx has no such field. */
export const setHeadlessRun = (ctx: object): void => {
    (ctx as { headless?: boolean }).headless = true;
};

/** The agent forwards the action ctx to tools as their `ToolCtx`, which declares `startedBy`; the action ctx has no such field. */
export const setRunStartedBy = (ctx: object, startedBy: string | undefined): void => {
    (ctx as { startedBy?: string }).startedBy = startedBy;
};

/**
 * A reply ended for good — drop the ciphertext of that reply's saved secret references (`requestSecret`). Best
 * effort: it must never fail or delay the end of a run, and what it misses waits for the housekeeping sweep.
 */
export const discardRunSecrets = async (ctx: Pick<ActionCtx, "runMutation">, run: { streamId: string; threadId: string }): Promise<void> => {
    try {
        await ctx.runMutation(internal.chat.request_secret.discardSecretsOfThread, { streamId: run.streamId, threadId: run.threadId as Id<"threads"> });
    } catch {
        // Swept later.
    }
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

/** A memory as retrieval returns it, for the per-minute cache. */
type RetrievedMemory = { category: string; confidence: number; memory: string; memoryId: string; score: number };

/** Fewer words than this and the prompt is not searched for memories. */
const MIN_MEMORY_SEARCH_WORDS = 3;
// Word-like segments by the locale's rules. Splitting on whitespace counts a Chinese or
// Japanese sentence (no spaces) as one word, so such a prompt never reached memory search.
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
const MEMORY_RETRIEVAL_CACHE_TTL_MS = 60_000;

/** Word-like segments of a prompt, by the locale's rules (see {@link WORD_SEGMENTER}). */
export const countSearchWords = (text: string): number => {
    let count = 0;

    for (const segment of WORD_SEGMENTER.segment(text)) {
        if (segment.isWordLike) {
            count += 1;
        }
    }

    return count;
};

/** The memory block for the system prompt, and which memories went into it. */
const retrieveMemories = async (
    ctx: ActionCtx,
    userId: string,
    searchText: string,
    botId?: string,
): Promise<{ context: string | undefined; refs: RetrievedMemoryRef[] }> => {
    // A prompt of two words or fewer ("thanks", "ok", "yes") has nothing to match
    // a memory against, so it skips the embedding and the vector search.
    if (countSearchWords(searchText) < MIN_MEMORY_SEARCH_WORDS) {
        return { context: undefined, refs: [] };
    }

    try {
        // A turn in a thread someone shared runs on THEIR shard, and this user's
        // memories live on their own — read there (`servesUser`). Only the
        // caller's own memories, for the caller's own turn: no wider access.
        //
        // The same question twice in a minute (a regenerate, a retry) is answered
        // from a 60 s cache. A memory deleted in that minute can still reach one
        // reply, which is the cost of skipping the embedding call.
        const memories = servesUser(userId)
            ? await new ActionCache<{ botId?: string; searchText: string; userId: string }, RetrievedMemory[]>(undefined, {
                  action: internal.memory.retrieve.retrieveRelevantMemories,
                  name: "memory/retrieve",
                  ttl: MEMORY_RETRIEVAL_CACHE_TTL_MS,
              }).fetch(ctx, { botId, searchText: searchText.trim().toLowerCase(), userId })
            : await callOnShard(internal.memory.retrieve.retrieveRelevantMemories, { botId, searchText, userId }, { shardKey: userId });

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

export const retrieveMemoryContext = async (ctx: ActionCtx, userId: string, searchText: string, botId?: string): Promise<string | undefined> => {
    const { context } = await retrieveMemories(ctx, userId, searchText, botId);

    return context;
};

/**
 * Knowledge-base excerpts for the prompt, numbered for citation, and the
 * `source` documents that back the numbers (`knowledge/citations.ts`).
 */
const retrieveKnowledgeContext = async (
    ctx: Pick<ActionCtx, "runAction">,
    args: { admittedRun?: boolean; query: string; threadId: string; userId: string },
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
    ctx: ActionCtx,
    args: {
        /** Set only by a caller whose run was admitted by the stream gate: a locked chat's knowledge scope is empty without it. */
        admittedRun?: boolean;
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
    // A missing or foreign bot reads as null: the chat runs as the plain assistant,
    // on the user's own memories.
    const botPromise = threadSettingsPromise.then(async (settings) => {
        if (!settings?.botId) {
            return null;
        }

        const bot = await ctx.runQuery(internal.bots.functions.getBotForRun, { botId: settings.botId, userId });

        return bot ? { ...bot, botId: settings.botId } : null;
    });
    const [prefs, threadSettings, userProviderKeys, memoryContext, knowledgeContext, project, bot] = await Promise.all([
        prefsPromise,
        threadSettingsPromise,
        loadUserProviderKeys(ctx, userId),
        prefsPromise.then(async (loaded) => {
            if (!loaded.memoryEnabled || !retrievalText) {
                return undefined;
            }

            const memoryBot = await botPromise;

            return await retrieveMemories(ctx, userId, retrievalText, memoryBot?.botId);
        }),
        retrievalText ? retrieveKnowledgeContext(ctx, { ...(args.admittedRun && { admittedRun: true }), query: retrievalText, threadId, userId }) : undefined,
        threadSettingsPromise.then(async (settings) =>
            settings?.projectId ? await ctx.runQuery(api.agent.projects.getProject, { projectId: settings.projectId as Id<"projects"> }) : null,
        ),
        botPromise,
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

    if (bot) {
        contextParts.push(`BOT (${bot.name}) INSTRUCTIONS:\n${bot.instructions}`);
    }

    if (customSystemPrompt) {
        contextParts.push(`ADDITIONAL INSTRUCTIONS:\n${customSystemPrompt}`);
    }

    return {
        /** The bot this chat runs as, when it resolves; its memory is written in that scope. */
        botId: bot?.botId,
        /** Appended to the agent's instructions, in this order. */
        contextParts,
        /** The passages behind the `[n]` citations; `afterRun` records them on the reply. */
        knowledgeSources: knowledgeContext?.sources ?? [],
        memoryEnabled: prefs.memoryEnabled,
        prefs: {
            backupModel: prefs.backupModel,
            language: args.threadLanguage || prefs.language,
            location: prefs.location,
            personalization: toPersonalization(prefs),
            threadSummariesEnabled: prefs.threadSummariesEnabled,
            timezone: prefs.timezone,
        },
        researchDepth: toResearchDepth(args.researchDepth),
        /** Memories injected above; `afterRun` records them on the reply. */
        retrievedMemories: memoryContext?.refs ?? [],
        threadSettings,
        /** Knowledge, memory or project context is in the prompt: the quick check for low-risk tool calls never runs (`low-risk-approval.ts`). */
        untrustedContext: injectsUntrustedContext({
            knowledge: knowledgeContext?.context,
            memory: memoryContext?.context,
            project: project?.context,
            threadPrompt: threadSettings?.customSystemPrompt,
        }),
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
 * Bookkeeping after a streamed run: the reply's timing (awaited before this
 * returns, so the action does not end with it in flight), the memories its
 * prompt carried, and — when `extractMemory` is set — memory extraction from
 * the exchange plus the activity stamp nightly reflection schedules from
 * (`memory/reflection.ts`). Billing is not here; the LLM Gateway usage webhook
 * owns it.
 */
export const afterRun = async (
    ctx: Pick<ActionCtx, "runMutation" | "scheduler">,
    args: {
        /** The bot the run is for, so its memory extraction stays in that bot's scope. */
        botId?: string;
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
        /** What the user sent into the reply while it ran (`createRunSteering`); memory extraction reads it with the prompt. */
        steeredTexts?: ReadonlyArray<string>;
        /**
         * The replying user's `threadSummariesEnabled`. Off (the default) schedules no summary job at all; the job
         * re-checks the thread owner's own setting, which is the one that decides.
         */
        summarizeThread: boolean;
        threadId: string;
        /** The user's IANA zone, so the usage heatmap files the reply under their calendar day. */
        timeZone?: string;
        timingStart: number;
        userId: string;
    },
): Promise<void> => {
    const { firstTokenTime, savedMessages = [], timingStart } = args;
    const lastAssistantMessage = savedMessages.findLast((m) => !m.tool);

    // Started first so it runs beside the scheduling below, awaited last so a
    // returning action never leaves it in flight. A failed patch only loses a timing.
    const timing = lastAssistantMessage
        ? (async () =>
              ctx.runMutation(internal.agent.messages.patchMessageTiming, {
                  durationMs: Date.now() - timingStart,
                  messageId: lastAssistantMessage._id as Id<"messages">,
                  ...(firstTokenTime !== undefined && { ttftMs: firstTokenTime - timingStart }),
              }))().catch((error: unknown) => {
              streamLogger.warn("[afterRun] Recording the reply's timing failed:", error);
          })
        : undefined;

    try {
        const results = await scheduleAfterRun(ctx, args);

        for (const result of results) {
            if (result.status === "rejected") {
                streamLogger.warn("[afterRun] Scheduling the post-run work failed:", result.reason);
            }
        }
    } catch (error) {
        streamLogger.warn("[afterRun] Scheduling the post-run work failed:", error);
    }

    await timing;
};

/** Schedules every post-run job and settles once each `runAfter` has; a rejected one is in the result, not thrown. */
const scheduleAfterRun = async (ctx: Pick<ActionCtx, "scheduler">, args: Parameters<typeof afterRun>[1]): Promise<PromiseSettledResult<unknown>[]> => {
    const { prompt, savedMessages = [], steeredTexts = [], threadId, userId } = args;
    const scheduled: Promise<unknown>[] = [];

    const firstReplyRow = savedMessages.find((m) => m.message?.role !== "user");

    // The citation chips behind the reply's `[n]`. Messages live on the thread's
    // shard, which is where this runs.
    if (firstReplyRow && args.knowledgeSources && args.knowledgeSources.length > 0) {
        scheduled.push(
            ctx.scheduler.runAfter(0, internal.knowledge.functions.recordKnowledgeSources, {
                messageId: firstReplyRow._id as Id<"messages">,
                sources: [...args.knowledgeSources],
            }),
        );
    }

    // The "memories used" popover reads the memory rows on the THREAD's shard;
    // a collaborator's memories are on their own, so theirs are not recorded.
    if (firstReplyRow && args.retrievedMemories && args.retrievedMemories.length > 0 && servesUser(userId)) {
        scheduled.push(
            ctx.scheduler.runAfter(0, internal.memory.functions.recordRetrievedMemories, {
                memories: [...args.retrievedMemories],
                messageId: firstReplyRow._id as Id<"messages">,
                userId,
            }),
        );
    }

    // A long thread's older turns are summarised once it has been idle (`agent/thread-summaries.ts`). The job
    // names this reply's last row; a newer reply makes it a no-op, which is the debounce. It belongs to the thread,
    // so it runs on the thread's shard whoever replied.
    const lastSaved = lastRowOf(savedMessages);

    if (args.summarizeThread && lastSaved && lastSaved.order >= SUMMARY_MIN_ORDER) {
        scheduled.push(
            ctx.scheduler.runAfter(SUMMARY_IDLE_MS, internal.agent.thread_summaries.runThreadSummary, {
                afterMessageId: lastSaved._id as Id<"messages">,
                threadId: threadId as Id<"threads">,
            }),
        );
    }

    // Daily Brief (`notifications/daily-brief.ts`): activity keeps the next
    // morning's run scheduled for users who opted in. Throttled per isolate — the
    // job is a no-op read for everyone else, and scheduling it on every reply
    // would put one job per reply on the user's lane.
    if (servesUser(userId) && shouldNoteBriefActivity(userId)) {
        scheduled.push(ctx.scheduler.runAfter(0, internal.notifications.daily_brief.noteDailyBriefActivity, { userId }));
    }

    // Usage heatmap + per-skill breakdown (`usage/activity.ts`), on the user's own shard.
    // One record per reply: a steered run saved two (`repliesByOrder`).
    scheduleRepliesUsage(ctx.scheduler as never, savedMessages, {
        at: Date.now(),
        userId,
        ...(args.skill && { skill: args.skill }),
        ...(args.timeZone && { timeZone: args.timeZone }),
    });

    if (!args.extractMemory || !prompt) {
        return await Promise.allSettled(scheduled);
    }

    // Memory is the USER's: in a thread someone shared, the extraction runs on
    // the collaborator's own shard, not the owner's this turn ran on.
    const memoryShard = servesUser(userId) ? undefined : userId;
    const scheduleMemory = async <A extends Record<string, unknown>>(target: { __lunoraRef: string }, jobArgs: A): Promise<string> =>
        memoryShard === undefined
            ? await ctx.scheduler.runAfter(0, target as never, jobArgs as never)
            : await runAfterOnShard(ctx.scheduler, 0, target, jobArgs, memoryShard);

    scheduled.push(scheduleMemory(internal.memory.reflection.noteMemoryActivity, { userId }));

    const assistantText = savedMessages
        .filter((m) => !m.tool && m.message?.role === "assistant")
        .map((m) => (typeof m.message?.content === "string" ? m.message.content : ""))
        .filter(Boolean)
        .join("\n");

    if (assistantText.length === 0) {
        return await Promise.allSettled(scheduled);
    }

    const toolResults = summariseToolResults(savedMessages);

    scheduled.push(
        scheduleMemory(internal.memory.extract.extractMemories, {
            ...(args.botId && { botId: args.botId }),
            assistantResponse: assistantText.slice(0, 4000),
            threadId: threadId as Id<"threads">,
            userId,
            // A steer can carry the very fact worth keeping ("actually, I'm vegetarian"); `steeredFrom` keeps it whole when a long prompt is cut.
            userMessage: [prompt, ...steeredTexts].join("\n\n"),
            ...(steeredTexts.length > 0 && { steeredFrom: prompt.length + 2 }),
            ...(toolResults.length > 0 && { toolResults: toolResults.slice(0, 10) }),
        }),
    );

    return await Promise.allSettled(scheduled);
};

/**
 * The streamText arguments every run shares: provider-keyed reasoning options
 * and, for auto-continue, context compression between steps. Callers add their
 * own prompt / system fields on top.
 */
export const buildRunStreamArgs = (options: {
    backupModelId?: string;
    /** Whether the calls carry tools: a backup that cannot call them is skipped for such a call, so it does not size the prompt. */
    hasTools?: boolean;
    model: string;
    reasoningEffort: number | undefined;
    shouldAutoContinue?: boolean;
}): Record<string, unknown> => {
    const { backupModelId, hasTools, model, reasoningEffort } = options;
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

    // Every run compresses between steps, not only auto-continue ones: a 5-step
    // run's tool results pile up after the one-shot check in `applyLateCompression`.
    // `shouldAutoContinue` no longer changes this; it stays in the type so callers
    // need no edit.
    const backupDefinition = backupModelId ? MODEL_LOOKUP.get(backupModelId) : undefined;
    const backupTraits = backupDefinition ? backupCapabilities(backupDefinition) : undefined;

    streamTextArgs.prepareStep = ({ messages }: { messages: unknown[] }) => {
        // Sized for the backup only while it could take the call (same rule as the wrapper's switch).
        const sizedFor = !backupTraits || backupCanServe(backupTraits, { hasTools: hasTools === true, messages }) ? backupModelId : undefined;
        const compressed = compressContextMessages(messages as never, getFallbackContextWindow(model, sizedFor));

        return compressed === messages ? undefined : { messages: compressed };
    };

    return streamTextArgs;
};

/**
 * What a run that may pause carries in its approval snapshot: that it was mined for memory, and for
 * which bot. The run extracts its own prompt and steers at the pause (`afterRun`), so an approval that
 * never completes loses nothing; the continuation extracts only the messages steered into it.
 * Nothing when the run is not mined.
 */
export const memoryToCarry = (run: { botId?: string; extractMemory: boolean; prompt: string }): ToolRunConfig["memory"] =>
    run.extractMemory && run.prompt ? { ...(run.botId && { botId: run.botId }) } : undefined;

/**
 * Steering for one interactive run (`chat/steering.ts`). `takeSteer` is the
 * agent's step-boundary hook; `steeredBefore` tells the stream pipe that a
 * message was delivered before the step now starting, so it writes the
 * `restart` marker (`persist-stream.ts`) once per delivery. Deliveries made
 * before the pipe reached their step are counted: each call answers one.
 *
 * A failed delivery is logged and the run carries on: its steers stay queued,
 * and the client sends them after the reply as ordinary messages.
 */
export const createRunSteering = (
    ctx: Pick<ActionCtx, "runMutation">,
    run: { streamId: string; threadId: string; userId: string },
): { steeredBefore: () => boolean; steeredTexts: () => string[]; takeSteer: TakeSteer } => {
    let restartsDue = 0;
    const texts: string[] = [];

    return {
        steeredBefore: () => {
            const due = restartsDue > 0;

            if (due) {
                restartsDue -= 1;
            }

            return due;
        },
        steeredTexts: () => [...texts],
        takeSteer: async ({ pendingMessageId }) => {
            try {
                const delivered = await ctx.runMutation(internal.chat.steering.deliverSteers, {
                    pendingMessageId,
                    streamId: run.streamId as Id<"persistentStreams">,
                    threadId: run.threadId as Id<"threads">,
                    userId: run.userId,
                });

                if (delivered) {
                    restartsDue += 1;
                    texts.push(delivered.text);
                }

                return delivered;
            } catch (error) {
                streamLogger.warn("[AgentRun] Steer delivery failed:", error);

                return null;
            }
        },
    };
};

/** What `stampSavedToolCalls` needs of a run: its labels and auto-approvals, and the rows it saved. */
export interface SavedToolCallStamp {
    autoApprovals?: AutoApprovals;
    mcpLabels: McpToolLabels;
    savedMessages: ReadonlyArray<{ _id: string; message?: { content?: unknown; role?: string } }> | undefined;
    userId: string;
}

/**
 * Stamps the run's saved MCP tool calls with their real names and the record of each call the quick check let run
 * unasked (`labelMcpToolCalls`). Idempotent: a call that is already stamped is left alone, so every end of a run may
 * call it.
 */
export const stampSavedToolCalls = async (ctx: Pick<ActionCtx, "runMutation">, stamp: SavedToolCallStamp): Promise<void> => {
    const { autoApprovals = {}, mcpLabels, savedMessages, userId } = stamp;
    const labelledIds = (savedMessages ?? []).flatMap((m) => (labelMcpToolCalls(m.message?.content, mcpLabels, autoApprovals) ? [m._id] : []));

    if (labelledIds.length > 0) {
        await ctx.runMutation(internal.chat.mcp_tool_labels.labelToolCalls, { autoApprovals, labels: mcpLabels, messageIds: labelledIds, userId });
    }
};

/** Stamps like `stampSavedToolCalls` for a run that is ending anyway (a stop or a failure): a failed stamp is logged and never masks how the run ended. */
const stampSavedToolCallsQuietly = async (ctx: Pick<ActionCtx, "runMutation">, stamp: SavedToolCallStamp): Promise<void> => {
    try {
        await stampSavedToolCalls(ctx, stamp);
    } catch (error) {
        streamLogger.warn("[AgentRun] Could not stamp the saved tool calls:", error);
    }
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
        /** Calls the quick check let run unasked (`BuildAgentToolsResult.autoApprovals`), stamped onto the saved calls. */
        autoApprovals?: AutoApprovals;
        keepOpenUnlessPaused?: boolean;
        mcpLabels: McpToolLabels;
        pending: { reasoning: string; text: string };
        savedMessages: ReadonlyArray<{ _id: string; message?: { content?: unknown; role?: string } }> | undefined;
        snapshot: ToolRunConfig;
        streamId: string;
        threadId: string;
        /** Text written since the run's last finished step: with `pending`, what a stop leaves owed to the reply. */
        unsaved?: StreamText;
        userId: string;
    },
): Promise<{ awaitingInput: AwaitingInput | undefined; paused: boolean }> => {
    const {
        autoApprovals = {},
        keepOpenUnlessPaused,
        mcpLabels,
        pending,
        savedMessages,
        snapshot,
        streamId,
        threadId,
        unsaved = { reasoning: "", text: "" },
        userId,
    } = args;

    await stampSavedToolCalls(ctx, { autoApprovals, mcpLabels, savedMessages, userId });

    const approvalIds = collectApprovalRequestIds(savedMessages);
    const askUserApprovalIds = collectAskUserApprovalIds(savedMessages, ASK_USER_TOOL_NAME);

    if (approvalIds.length > 0) {
        const secretApprovalIds = collectAskUserApprovalIds(savedMessages, REQUEST_SECRET_TOOL_NAME);

        await ctx.runMutation(internal.chat.tool_permissions.recordPendingToolApprovals, {
            approvalIds,
            ...(askUserApprovalIds.length > 0 && { askUserApprovalIds }),
            config: snapshot,
            ...(secretApprovalIds.length > 0 && { secretApprovalIds }),
            threadId,
            userId,
        });
    }

    const paused = approvalIds.length > 0;

    try {
        await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
            final: paused || keepOpenUnlessPaused !== true,
            reasoning: pending.reasoning || undefined,
            streamId: streamId as Id<"persistentStreams">,
            text: pending.text,
        });
    } catch (error) {
        // A stop can end the stream between the pipe and this write: what was owed is then the unsaved text plus `pending`.
        throw asRefusedWrite(error, { reasoning: unsaved.reasoning + pending.reasoning, text: unsaved.text + pending.text });
    }

    // A pause keeps the references (a consumer set to ask resumes the run); only a final end drops them. A group turn that
    // goes on with the next speaker (`keepOpenUnlessPaused`) is not over either.
    if (!paused && keepOpenUnlessPaused !== true) {
        await discardRunSecrets(ctx, { streamId, threadId });
    }

    // A question when every pending call waits on the person's own input (askUser, or a secret card); any other tool
    // in the set is an approval.
    let awaitingInput: AwaitingInput | undefined;

    if (paused) {
        const secretPending = collectAskUserApprovalIds(savedMessages, REQUEST_SECRET_TOOL_NAME).length;

        awaitingInput = askUserApprovalIds.length + secretPending === approvalIds.length ? "question" : "approval";
    }

    return { awaitingInput, paused };
};

/**
 * A sidebar stop refused one of this run's chunk writes. The text the reply still owes is saved first
 * (`finishStoppedReply`), and only then is the model call aborted: the agent marks its pending row failed on
 * abort, which would undo the save. The aborted result is then drained, so a step the agent was saving when the
 * stop landed is written before this returns. A save that is rejected still aborts and drains before its error is rethrown. Any other error, and a refusal that was not a stop, is rethrown as it was.
 *
 * Returns the ids of the rows this saved (none when no text was owed).
 */
export const endStoppedRun = async (
    ctx: Pick<ActionCtx, "runMutation">,
    error: unknown,
    args: {
        agentName?: string;
        /** A continuation's reply takes its own order (`order`) and branches from the tool result (`promptMessageId`). */
        continuation: boolean;
        order: number | undefined;
        promptMessageId: string | undefined;
        result: { consumeStream: () => PromiseLike<unknown>; savedMessages?: SavedToolCallStamp["savedMessages"] };
        /** Stamps the run's auto-approved calls (and labels) onto the rows saved before the stop, once the aborted result is drained. */
        stamp?: Omit<SavedToolCallStamp, "savedMessages">;
        stop: AbortController;
        streamId: string;
        threadId: string;
    },
): Promise<string[]> => {
    if (!isStreamWriteRefused(error)) {
        throw error;
    }

    // The metadata is set on every streamText result; without it the reply has no place to be saved.
    if (args.order === undefined || args.promptMessageId === undefined) {
        throw originalWriteError(error);
    }

    const stopped = await ctx
        .runMutation(internal.chat.streaming.persistent.library.finishStoppedReply, {
            ...(args.agentName !== undefined && { agentName: args.agentName }),
            continuation: args.continuation,
            order: args.order,
            pendingReasoning: error.pending.reasoning,
            pendingText: error.pending.text,
            promptMessageId: args.promptMessageId,
            streamId: args.streamId as Id<"persistentStreams">,
        })
        .catch(async (saveError: unknown) => {
            // The save was rejected (an owed text past the stored-document limit): the run is over all the same, so the model call must not keep going.
            args.stop.abort();
            await args.result.consumeStream();

            throw saveError;
        });

    if (!stopped.stopped) {
        throw originalWriteError(error);
    }

    args.stop.abort();
    // Errors are reported on the result, not thrown; the abort ends the stream, so this returns once the save is done.
    await args.result.consumeStream();
    await discardRunSecrets(ctx, { streamId: args.streamId, threadId: args.threadId });

    if (args.stamp) {
        await stampSavedToolCallsQuietly(ctx, { ...args.stamp, savedMessages: args.result.savedMessages });
    }

    return stopped.messageId === undefined ? [] : [stopped.messageId];
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
 * - `steerable`: the continuation takes steered messages (`createRunSteering`).
 *   Interactive one-assistant runs only, never a group participant.
 */
export const resumeApprovedRun = async (
    ctx: ActionCtx,
    args: {
        /** An approved `askUser` call's answer, or a saved `requestSecret`'s reference: the resumed tool returns it as its result. */
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
        /**
         * The caller passed the stream gate for this run (`streamRunThread`), so the knowledge tool may
         * search the chat's own files. Only a continuation that passed the gate may set it.
         */
        admittedRun?: boolean;
        afterSaved?: (saved: { messageIds: string[]; toolResultId: string | undefined }) => Promise<void>;
        agentName?: string;
        beforeStream?: () => Promise<void>;
        contextHandler?: ContextHandler;
        keepOpenUnlessPaused?: boolean;
        steerable?: boolean;
    } = {},
): Promise<{ awaitingInput?: AwaitingInput; lastMessageId: string | undefined; paused: boolean; stopped: boolean }> => {
    const { answer, approvalId, approved, config, denyReason, streamId, threadId, userId } = args;
    const { customProvider } = await resolveRunModel(ctx, config.model, userId);
    const [toolResult, userProviderKeys, preferences] = await Promise.all([
        buildAgentTools(ctx, {
            ...(options.admittedRun && { admittedRun: true }),
            autoMediaEnrichment: config.autoMediaEnrichment,
            // A person just answered in the chat, so this run is interactive.
            deviceThreadId: threadId,
            mcpProgress: toolProgressSink(ctx, streamId),
            model: config.model,
            origin: config.dispatchOrigin,
            searchMode: config.searchMode as SearchMode,
            snapshot: { mcpServerNames: config.mcpServerNames, toolNames: config.toolNames },
            threadId,
            // The paused run's prompt is reused as it was; a snapshot that does not say counts as carrying such context.
            untrustedContext: config.untrustedContext ?? true,
            userId,
        }),
        loadUserProviderKeys(ctx, userId),
        ctx.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId }),
    ]);

    // Set once the continuation has a result: a run that fails after it still leaves the record of its auto-approved calls.
    let started: { savedMessages?: SavedToolCallStamp["savedMessages"] } | undefined;

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

        // An answered secret request: the call's result is the stored value's reference, never the value.
        if (approved && pending.toolName === REQUEST_SECRET_TOOL_NAME) {
            if (answer === undefined) {
                throw new AgentRunError("stale-approval", "A secret request can only be resumed with a reference");
            }

            const { createAnsweredRequestSecretTool } = await import("../tools/request-secret");

            toolResult.tools[REQUEST_SECRET_TOOL_NAME] = createAnsweredRequestSecretTool(answer) as (typeof toolResult.tools)[string];
        }

        const modelFilterRules = await loadModelFilterRules(ctx, userId);
        const backupModelId = await resolveBackupModelId(ctx, userId, preferences.backupModel, config.model, modelFilterRules);
        const agent = await getAgent(config.model, {
            backupModelId,
            customProvider,
            gateway: gatewayFetch(ctx),
            maxSteps: getMaxSteps(config.shouldAutoContinue),
            modelFilterRules,
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
        // The snapshot keeps what started the run: a person answering an approval does not make it the lead's.
        setDispatchOrigin(ctx, config.dispatchOrigin ?? "lead");
        // The continuation runs as the owner; who started the turn it resumes is in the snapshot (none for a snapshot that predates it).
        setRunStartedBy(ctx, config.startedBy);

        const stopping = new AbortController();
        const streamTextArgs = buildRunStreamArgs({
            backupModelId,
            hasTools: Object.keys(toolResult.tools).length > 0,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            shouldAutoContinue: config.shouldAutoContinue,
        });

        streamTextArgs.abortSignal = stopping.signal;
        streamTextArgs.stopWhen = stopWhenStopped(ctx, streamId, getMaxSteps(config.shouldAutoContinue));

        await options.beforeStream?.();

        const steering = options.steerable === true ? createRunSteering(ctx, { streamId, threadId, userId }) : undefined;
        const runOptions = { saveStreamDeltas: false, ...(steering && { takeSteer: steering.takeSteer }) };
        const result = approved
            ? await agent.approveToolCall(ctx, { threadId, userId }, { approvalId }, streamTextArgs as never, runOptions)
            : await agent.denyToolCall(
                  ctx,
                  { approvalId, ...(denyReason !== undefined && { reason: denyReason }), threadId },
                  streamTextArgs as never,
                  runOptions,
              );

        started = result;

        // The interactive path (`steerable`) does the bookkeeping of an ordinary run (`afterRun`): usage of each reply it
        // saved (a steered continuation saves a second one), timing and memory extraction of the messages steered into
        // this continuation (the run that paused extracted its own prompt and steers). A group participant's reply is keyed to
        // its speaker by the group run. The snapshot carries no skill, so a reply counts as the plain assistant's; the day
        // is the user's own, read from their settings.
        const timingStart = Date.now();
        let firstTokenTime: number | undefined;
        const recordRun = async (extractMemory: boolean): Promise<void> => {
            if (options.steerable !== true) {
                return;
            }

            const savedMessages = result.savedMessages ?? [];
            const prefs = await ctx.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });

            // The run that paused extracted its own prompt and steers; this one extracts the steers it took.
            const steered = steering?.steeredTexts() ?? [];

            await afterRun(ctx, {
                ...(config.memory?.botId && { botId: config.memory.botId }),
                extractMemory: extractMemory && config.memory !== undefined && prefs.memoryEnabled,
                firstTokenTime,
                prompt: steered.join("\n\n"),
                savedMessages,
                summarizeThread: prefs.threadSummariesEnabled,
                threadId,
                ...(prefs.timezone && { timeZone: prefs.timezone }),
                timingStart,
                userId,
            });
        };

        // A stop during this continuation ends it here, after its owed text is saved (`endStoppedRun`).
        // After a steer the reply continues below the steered message; `finishStoppedReply` reads that off the stream.
        const stoppedAt = async (error: unknown) => {
            await endStoppedRun(ctx, error, {
                agentName: options.agentName,
                continuation: true,
                order: result.order,
                promptMessageId: result.promptMessageId,
                result,
                stamp: { autoApprovals: toolResult.autoApprovals, mcpLabels: toolResult.mcpLabels, userId },
                stop: stopping,
                streamId,
                threadId,
            });

            // The steps that finished before the stop are a reply like any other on the usage page; nothing is mined for memory.
            await recordRun(false);

            return { lastMessageId: undefined, paused: false, stopped: true };
        };

        let piped: PipedStream;

        try {
            piped = await pipeToPersistentChunks(ctx, streamId, result.fullStream, { steeredBefore: steering?.steeredBefore });
        } catch (error) {
            return await stoppedAt(error);
        }

        firstTokenTime = piped.firstTokenTime;

        await result.consumeStream();

        const messageIds = (result.savedMessages ?? []).map((m) => m._id as string);

        if (messageIds.length > 0) {
            await options.afterSaved?.({
                messageIds,
                toolResultId: (result.savedMessages?.[0] as { parentMessageId?: string } | undefined)?.parentMessageId,
            });
        }

        let paused: boolean;
        let awaitingInput: AwaitingInput | undefined;

        try {
            ({ awaitingInput, paused } = await finishRun(ctx, {
                autoApprovals: toolResult.autoApprovals,
                keepOpenUnlessPaused: options.keepOpenUnlessPaused,
                mcpLabels: toolResult.mcpLabels,
                pending: piped.pending,
                savedMessages: result.savedMessages,
                snapshot: config,
                streamId,
                threadId,
                unsaved: piped.unsaved,
                userId,
            }));
        } catch (error) {
            return await stoppedAt(error);
        }

        await recordRun(true);

        return { awaitingInput, lastMessageId: messageIds.at(-1), paused, stopped: false };
    } catch (error) {
        if (started) {
            await stampSavedToolCallsQuietly(ctx, {
                autoApprovals: toolResult.autoApprovals,
                mcpLabels: toolResult.mcpLabels,
                savedMessages: started.savedMessages,
                userId,
            });
        }

        throw error;
    } finally {
        await closeMCPClients(toolResult.mcpClients);
    }
};

/** What the owner is being asked for when a run pauses. */
export type AwaitingInput = "approval" | "question";

/**
 * How a run left the thread, written in the SAME patch as its status (the thread list is a live query, so a second
 * write would re-run it): `awaitingInput` when it paused for the owner, `replied` when it finished successfully.
 * Going back to `running` removes `awaitingInput` (`agent/table-writes.ts#patchThread`, `updateThread`).
 */
export interface RunOutcome {
    awaitingInput?: AwaitingInput;
    replied?: boolean;
}

export const setThreadStatus = async (
    ctx: Pick<ActionCtx, "runMutation">,
    threadId: string,
    status: "active" | "error",
    outcome: RunOutcome = {},
): Promise<void> => {
    const now = Date.now();

    await ctx.runMutation(internal.agent.threads.updateThread, {
        patch: {
            status,
            updatedAt: now,
            ...(outcome.awaitingInput !== undefined && { awaitingInput: outcome.awaitingInput }),
            ...(outcome.replied === true && outcome.awaitingInput === undefined && { lastReplyAt: now }),
        },
        threadId: threadId as Id<"threads">,
    });
};

/**
 * Close a failed run: the (already sanitised) message goes to the stream so the
 * gateway can relay it — or, if even that fails, the stream is marked errored —
 * and the thread leaves `running`.
 */
export const failRun = async (
    ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
    args: {
        safeMessage: string;
        /** Stamps the run's auto-approved calls onto the rows it saved before it failed. Best effort: it runs after the run is closed. */
        stamp?: () => Promise<void>;
        streamId: string;
        threadId: string;
        threadStatus: "active" | "error";
    },
): Promise<void> => {
    const { safeMessage, stamp, streamId, threadId, threadStatus } = args;

    // `done` means someone else ended the stream: the sidebar's stop (`stopActiveForThread`),
    // or a finish whose tail threw. Such a run gets no error line, and the thread just leaves `running`.
    const readStatus = async () =>
        await ctx
            .runQuery(internal.chat.streaming.persistent.library.getStreamStatus, { streamId: streamId as Id<"persistentStreams"> })
            .catch(() => undefined);
    let endedElsewhere = (await readStatus()) === "done";

    if (!endedElsewhere) {
        try {
            await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
                final: true,
                streamId: streamId as Id<"persistentStreams">,
                text: `\n\nError: ${safeMessage}`,
            });
        } catch {
            // A stop can land between the read above and the write, which then refuses it. Read again before
            // calling it a failure, so a stopped run never ends in `error`.
            endedElsewhere = (await readStatus()) === "done";

            if (!endedElsewhere) {
                await ctx.runMutation(internal.chat.streaming.persistent.library.setStreamStatus, {
                    status: "error",
                    streamId: streamId as Id<"persistentStreams">,
                });
            }
        }
    }

    // A stopped run that fails here never saves the text it owed, so its stop is over (`settleStoppedRun`).
    if (endedElsewhere) {
        await ctx
            .runMutation(internal.chat.streaming.persistent.library.settleStoppedRun, { streamId: streamId as Id<"persistentStreams"> })
            .catch(() => undefined);
    }

    // A goal that replaced this run's own owns the thread: its status is not this run's to set.
    const replaced = await ctx
        .runQuery(internal.chat.goals.internal.otherGoalHoldsThread, { streamId: streamId as Id<"persistentStreams">, threadId: threadId as Id<"threads"> })
        .catch(() => false);

    if (!replaced) {
        try {
            await setThreadStatus(ctx, threadId, endedElsewhere ? "active" : threadStatus);
        } catch {
            // Ignore cleanup errors
        }
    }

    // A failed run ends the goal it belonged to, and only that one: no review follows a run that never finished.
    try {
        await ctx.runMutation(internal.chat.goals.internal.endGoalsForThread, {
            reason: "error",
            streamId: streamId as Id<"persistentStreams">,
            threadId: threadId as Id<"threads">,
        });
    } catch {
        // The goal's own stall sweep ends it (`reapStalledGoals`).
    }

    await discardRunSecrets(ctx, { streamId, threadId });

    try {
        await stamp?.();
    } catch (error) {
        streamLogger.warn("[AgentRun] Could not stamp the saved tool calls:", error);
    }
};
