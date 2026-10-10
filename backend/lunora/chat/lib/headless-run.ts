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
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { sumMessageCosts } from "../../agent/message-cost";
import type { SkillConfig } from "../../skills/validators";
import { buildRunStreamArgs, loadUserProviderKeys, resolveRunModel, retrieveMemoryContext, setResearchDepth, toPersonalization } from "./agent-run";
import { buildAgentTools } from "./agent-tools";
import { getMaxSteps } from "./auto-continue";
import { gatewayFetch } from "../../lib/services";
import getAgent from "./get-agent";
import { closeMCPClients } from "./mcp-tools";
import type { SearchMode } from "./tool-builder";
import { servesUser } from "../../lib/shard-context";
import { applyToolAllowlist } from "../../sub-agents/logic";
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
    /** A step cap for a quick reply. Default: Deep Work's budget, with context compression between steps. */
    maxSteps?: number;
    /** Retrieve memories before, and extract them after. */
    memory: boolean;
    model: string;
    /** Called with the new thread's id before generation starts, so a failure can still point at it. */
    onThread?: (threadId: string) => Promise<void> | void;
    /** Whether the user's personalization reaches the prompt — `"none"` when someone else reads the reply. */
    personalization: "full" | "none";
    /** Omitted when continuing a thread: its latest message is the prompt. */
    prompt?: string;
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

        const existingThreadId = "threadId" in options.thread ? options.thread.threadId : undefined;
        const personal = options.personalization === "full";
        const agent = await getAgent(model, {
            customProvider,
            gateway: gatewayFetch(ctx),
            language: prefs.language,
            location: personal ? prefs.location : undefined,
            maxSteps: options.maxSteps ?? getMaxSteps(true),
            personalization: personal ? toPersonalization(prefs) : undefined,
            skillContext: skill ? { config: skill.config, instructions: skill.instructions } : undefined,
            threadId: existingThreadId,
            timezone: prefs.timezone,
            tools: applyToolAllowlist(toolResult.tools, toolAllowlist),
            userId,
            userProviderKeys,
        });

        const memoryContext = extractMemory && prompt ? await retrieveMemoryContext(ctx, userId, prompt) : undefined;
        const extraParts = [options.system, memoryContext].filter((part): part is string => !!part);
        const generateArgs: Record<string, unknown> = {
            ...buildRunStreamArgs({ model, reasoningEffort: skill?.config?.reasoningEffort, shouldAutoContinue: options.maxSteps === undefined }),
            ...(prompt !== undefined && { prompt }),
            // Without extra parts the agent falls back to its own instructions.
            ...(extraParts.length > 0 && { system: [agent.options.instructions, ...extraParts].filter(Boolean).join("\n\n") }),
        };

        let threadId: string;
        let thread;

        if (existingThreadId === undefined) {
            await options.beforeThread?.();

            const created = await agent.createThread(ctx, { title: (options.thread as { title: string }).title, userId });

            threadId = created.threadId;
            thread = created.thread!;
            await options.onThread?.(threadId);
        } else {
            threadId = existingThreadId;
            ({ thread } = await agent.continueThread(ctx, { threadId, userId }));
        }

        const result = await thread.generateText(generateArgs as never);
        const text = result.text ?? "";
        const tags = "tags" in options.thread ? options.thread.tags : undefined;

        await ctx.runMutation(internal.agent.threads.updateThread, {
            patch: { status: "active", ...(tags && { tags }), updatedAt: Date.now() },
            threadId: threadId as Id<"threads">,
        });

        if (extractMemory && text && prompt && servesUser(userId)) {
            void ctx.scheduler.runAfter(0, internal.memory.extract.extractMemories, {
                assistantResponse: text.slice(0, 4000),
                threadId: threadId as Id<"threads">,
                userId,
                userMessage: prompt,
            });
        }

        // Usage heatmap + per-skill breakdown, keyed on the reply's first row so a
        // redelivered record counts once.
        scheduleReplyUsage(
            ctx.scheduler as never,
            replyUsageArgs((result as { savedMessages?: ReadonlyArray<SavedRowLike> }).savedMessages ?? [], {
                at: Date.now(),
                userId,
                ...(options.usageSkill && { skill: options.usageSkill }),
                ...(prefs.timezone && { timeZone: prefs.timezone }),
            }),
        );

        const cost = sumMessageCosts((result.steps ?? []).map((step: { providerMetadata?: unknown }) => step.providerMetadata));

        return { costMicrodollars: cost?.microdollars, text, threadId, totalTokens: result.totalUsage?.totalTokens };
    } finally {
        await closeMCPClients(toolResult.mcpClients);
    }
};
