/**
 * Background Agent Execution Action
 *
 * Runs the full agent loop as a background scheduled action.
 * Survives client disconnects — writes chunks only to the database (persistentChunks table).
 * The LLM Gateway polls for chunks and relays them to the client over SSE.
 *
 * Scheduled by /chat/start for every text streaming request.
 *
 * `continueAfterToolApproval` is the same run resumed after the user answers a
 * `tool-approval-request` (scheduled by `respondToToolApproval` in
 * `chat/tool-permissions.ts`): it rebuilds the run from its `toolApprovalRuns`
 * snapshot, lets the agent execute (or deny) the call, and pipes the
 * continuation into `persistentChunks` exactly like the original run. What the
 * two share lives in `lib/agent-run.ts`.
 */
import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { streamLogger } from "../lib/logger";
import { findSkillCommand, parseSkillCommand, resolveReasoningEffort, resolveSkillModel } from "../skills/slash-command";
import { continueGroupAfterToolApproval, runGroupTurn } from "./group/run";
import {
    afterRun,
    AgentRunError,
    buildRunStreamArgs,
    failRun,
    finishRun,
    isAgentRunError,
    loadRunContext,
    resolveRunModel,
    resumeApprovedRun,
    setResearchDepth,
    setThreadStatus,
} from "./lib/agent-run";
import { buildAgentTools } from "./lib/agent-tools";
import { getMaxSteps } from "./lib/auto-continue";
import { gatewayFetch } from "../lib/services";
import getAgent from "./lib/get-agent";
import { closeMCPClients } from "./lib/mcp-tools";
import { pipeToPersistentChunks } from "./lib/persist-stream";
import classifyQuery from "./lib/query-classifier";
import detectTaskComplexity, { type TaskAnalysis } from "./lib/task-detector";
import type { SearchMode } from "./lib/tool-builder";
import { vToolRunConfig } from "./lib/tool-run-config";
import { toUserFacingError } from "./lib/user-facing-error";

export const runStreamingAgent = internalAction
    .input({
        /** Anonymous callers are pinned to the free model; a skill must not lift that. */
        isAnonymous: v.optional(v.boolean()),
        messageId: v.string(),
        /** The caller's active organization, verified by `/chat/start` — scopes organization-shared skills. */
        organizationId: v.optional(v.string()),
        streamId: v.string(),
        streamingConfig: v.object({
            contentType: v.string(),
            customSystemPrompt: v.optional(v.string()),
            enabledFeatures: v.optional(v.array(v.string())),
            imageSize: v.optional(v.string()),
            mcpServerNames: v.optional(v.array(v.string())),
            model: v.string(),
            reasoningEffort: v.optional(v.number()),
            researchDepth: v.optional(v.string()),
            searchMode: v.optional(v.string()),
            shouldAutoContinue: v.optional(v.boolean()),
            statelessMode: v.optional(v.boolean()),
        }),
        threadId: v.string(),
        userId: v.string(),
        /** The raw composer text, when the start payload had it — where a `/<slug>` command is detected. */
        userPrompt: v.optional(v.string()),
    })
    .action(async ({ args: { isAnonymous, messageId, organizationId, streamId, streamingConfig, threadId, userId, userPrompt }, ctx }) => {
        // Everything before the first token is on the user's wait, so the reads
        // that need nothing but the job's own arguments start together, WITH
        // the claim. They are queries: a redelivery that loses the claim reads
        // and discards, and generates nothing.
        const isSkillCommand = userPrompt !== undefined && Boolean(parseSkillCommand(userPrompt));
        const reads = Promise.all([
            ctx.runQuery(internal.agent.threads.getThreadWithAccess, { threadId: threadId as Id<"threads">, userId }),
            // Group chat: its participants take the turn (`group/run.ts`) — unless
            // the user invoked one skill directly with `/<slug>`.
            isSkillCommand ? null : ctx.runQuery(internal.chat.group.functions.getGroupRunConfig, { organizationId, threadId, userId }),
            ctx.runQuery(internal.agent.messages.getMessagesByIds, { messageIds: [messageId as Id<"messages">] }),
            ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId }),
        ]);

        // Settled either way below; this only keeps a failed read from being
        // reported as unhandled while the claim is still being awaited.
        reads.catch(() => undefined);

        // Enqueued on the jobs queue, which delivers at least once: only the
        // delivery that claims the stream may generate into it.
        if (!(await ctx.runMutation(internal.chat.streaming.persistent.library.claimStreamRun, { streamId: streamId as Id<"persistentStreams"> }))) {
            streamLogger.warn(`[BgAgent] Stream ${streamId} already claimed — ignoring a redelivered run`);

            return;
        }

        const startTime = Date.now();
        let mcpClients: import("@ai-sdk/mcp").MCPClient[] = [];

        const { customSystemPrompt, model: requestedModel, reasoningEffort, statelessMode } = streamingConfig;
        // Reassigned once, when an invoked skill names a preferred model.
        let model = requestedModel;

        try {
            streamLogger.debug(`[BgAgent] Starting background agent execution`, {
                messageId,
                streamId,
                threadId,
            });

            const [thread, groupConfig, sseMessages, agentModulePrefs] = await reads;

            // The thread, read with the caller's access checked.
            if (!thread) {
                await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
                    final: true,
                    streamId: streamId as Id<"persistentStreams">,
                    text: "\n\nError: Thread not found",
                });

                return;
            }

            if (groupConfig) {
                await runGroupTurn(
                    ctx,
                    { isAnonymous: isAnonymous === true, messageId, organizationId, streamId, streamingConfig, threadId, userId, userPrompt },
                    groupConfig,
                );

                return;
            }

            // Get prompt from message
            const message = sseMessages?.[0];
            const prompt = message?.text || "";
            // `saveMessage({ metadata: { fileIds } })` spreads its metadata onto the
            // message row itself (see agent/client/messages.ts), so attachments land
            // in `message.fileIds` — there is no `metadata` column on `messages`.
            const fileIds = message?.fileIds;

            // Skills: Level 1 metadata for the system prompt, and — for a message
            // starting `/<slug>` — the invoked skill's instructions, model and tool
            // config. The instructions ride on the agent's instructions, so the
            // tool-approval snapshot (which stores the final system prompt) keeps
            // them for a resumed run.
            // Preferences, thread settings, memory, knowledge base and project
            // context need only the prompt — not the skill or the model resolved
            // below — so they load while those do. Awaited with the tools; the
            // catch only marks it handled should a skill error end the run first.
            const runContextPromise = loadRunContext(ctx, {
                customSystemPrompt,
                promptText: prompt,
                researchDepth: streamingConfig.researchDepth,
                threadId,
                threadLanguage: thread.language,
                userId,
            });

            runContextPromise.catch(() => undefined);

            const skillCommand = findSkillCommand(userPrompt, message?.message?.content, prompt);
            const skillRun = await ctx.runQuery(internal.skills.executor.resolveSkillsForRun, {
                organizationId,
                rawArgs: skillCommand?.rawArgs,
                skillSlug: skillCommand?.slug,
                // A builder test-drive thread runs its unsaved draft as the invoked skill.
                threadId,
                userId,
            });

            if (skillRun.error) {
                throw new AgentRunError("skill", skillRun.error);
            }

            const invokedSkill = skillRun.invocation;

            model = resolveSkillModel(requestedModel, invokedSkill?.config?.preferredModel, (id) => MODEL_LOOKUP.get(id), isAnonymous === true);

            // Auto-detect task complexity
            let taskAnalysis: TaskAnalysis | undefined;
            let agentMode: { enableDatasource: boolean; enableKnowledge: boolean; enablePlanner: boolean };

            if (agentModulePrefs.autoDetectComplexity && prompt) {
                taskAnalysis = detectTaskComplexity(prompt);
                agentMode = {
                    enableDatasource: taskAnalysis.taskType === "research" || agentModulePrefs.enableDatasource,
                    enableKnowledge: taskAnalysis.isComplex || agentModulePrefs.enableKnowledge,
                    enablePlanner: taskAnalysis.requiresPlanning || agentModulePrefs.enablePlanner,
                };
            } else {
                agentMode = {
                    enableDatasource: agentModulePrefs.enableDatasource,
                    enableKnowledge: agentModulePrefs.enableKnowledge,
                    enablePlanner: agentModulePrefs.enablePlanner,
                };
            }

            // Build tools
            const streamSearchMode = (streamingConfig.searchMode as SearchMode) || "chat";
            let effectiveSearchMode = streamSearchMode;

            if (streamSearchMode !== "chat" && prompt) {
                const classification = classifyQuery(prompt, streamSearchMode);

                if (classification.classification === "direct_answer" && classification.confidence >= 0.85) {
                    effectiveSearchMode = "chat";
                }
            }

            // An invoked skill's search mode is deliberate, so it beats the classifier.
            if (invokedSkill?.config?.searchMode) {
                effectiveSearchMode = invokedSkill.config.searchMode as SearchMode;
            }

            // A custom endpoint gets no tools (built-in or MCP) unless the user
            // said its models support them.
            const { allowTools, customProvider } = await resolveRunModel(ctx, model, userId);

            // Built-ins + MCP tools, with the user's per-tool permissions applied
            // (`off` removed, `ask` gated behind a tool-approval request) — and
            // the run context started above.
            const [toolResult, runContext] = await Promise.all([
                allowTools
                    ? buildAgentTools(ctx, {
                          autoMediaEnrichment: agentModulePrefs.autoMediaEnrichment,
                          // Interactive: the user's devices, if this thread may reach them.
                          deviceThreadId: threadId,
                          mcpServerNames: streamingConfig.mcpServerNames,
                          model,
                          searchMode: effectiveSearchMode,
                          skillTools: invokedSkill?.config
                              ? { additionalTools: invokedSkill.config.additionalTools, disabledTools: invokedSkill.config.disabledTools }
                              : undefined,
                          userId,
                      })
                    : { mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools: {} },
                runContextPromise,
            ]);

            mcpClients = toolResult.mcpClients;

            const { tools } = toolResult;
            const { contextParts, prefs, researchDepth: effectiveResearchDepth, threadSettings: appThread } = runContext;

            setResearchDepth(ctx, effectiveResearchDepth);

            // Build agent
            const isAutoContinue = streamingConfig.shouldAutoContinue === true;

            const agent = await getAgent(model, {
                agentMode,
                customProvider,
                enabledSkills: skillRun.enabledSkills.length > 0 ? skillRun.enabledSkills : undefined,
                gateway: gatewayFetch(ctx),
                language: prefs.language,
                location: prefs.location,
                maxSteps: getMaxSteps(isAutoContinue),
                modelFilterRules: agentModulePrefs.modelFilterRules ?? undefined,
                personalization: prefs.personalization,
                skillContext: invokedSkill ? { config: invokedSkill.config, instructions: invokedSkill.instructions } : undefined,
                taskContext:
                    taskAnalysis && taskAnalysis.taskType !== "general"
                        ? {
                              requirePlanning: taskAnalysis.requiresPlanning,
                              requireValidation: taskAnalysis.requiresValidation,
                              taskType: taskAnalysis.taskType,
                              userMessage: prompt,
                          }
                        : undefined,
                threadId,
                timezone: prefs.timezone,
                tools,
                userId,
                userProviderKeys: runContext.userProviderKeys,
            });

            const threadResult = await agent.continueThread(ctx, { threadId, userId });
            const threadObject = threadResult.thread || threadResult;

            // Recorded in the approval snapshot below, so a resumed run keeps it.
            const threadReasoningEffort = resolveReasoningEffort({
                messageEffort: reasoningEffort,
                skillEffort: invokedSkill?.config?.reasoningEffort,
                threadEffort: appThread?.reasoningEffort,
            });
            const threadStatelessMode = appThread?.statelessMode ?? statelessMode;

            // Reasoning provider options and, for auto-continue, step compression.
            const streamTextArgs: any = buildRunStreamArgs({ model, reasoningEffort: threadReasoningEffort, shouldAutoContinue: isAutoContinue });

            if (threadStatelessMode) {
                streamTextArgs.prompt = prompt;
            } else {
                streamTextArgs.promptMessageId = messageId;
            }

            // Memory, knowledge base, project context and the thread's own
            // instructions — then a note about attached documents.
            const additionalParts = [...contextParts];

            if (fileIds && fileIds.length > 0) {
                additionalParts.push(
                    `CONTEXT: The user has attached document(s) to this message. Their content has been extracted and included inline. If appropriate, you can offer to create a slide presentation from the document content using the createPresentation tool.`,
                );
            }

            if (additionalParts.length > 0) {
                const baseInstructions = agent.options.instructions || "";
                const additionalContext = additionalParts.join("\n\n");

                streamTextArgs.system = baseInstructions ? `${baseInstructions}\n\n${additionalContext}` : additionalContext;
            }

            // Stream text
            const result = await threadObject.streamText(streamTextArgs, {
                statelessMode: threadStatelessMode,
            });

            // Write chunks to persistent storage (DB only, no HTTP response)
            const timingStart = Date.now();
            const { firstTokenTime, pending } = await pipeToPersistentChunks(ctx, streamId, result.fullStream);

            // Wait for the agent to save the final message
            await result.consumeStream();

            // No token counts here: awaiting `totalUsage` on the live path could
            // reject or stall a run that otherwise finished; a log line must not.
            ctx.log.event("chat.run_streaming_agent", { autoContinue: isAutoContinue, model });

            // Record the approval snapshot (if the run paused) and flush. The
            // snapshot is what the continuation rebuilds this exact run from.
            await finishRun(ctx, {
                mcpLabels: toolResult.mcpLabels,
                pending,
                savedMessages: result.savedMessages,
                snapshot: {
                    autoMediaEnrichment: agentModulePrefs.autoMediaEnrichment,
                    instructions: streamTextArgs.system ?? agent.options.instructions,
                    mcpServerNames: toolResult.mcpServerNames,
                    model,
                    reasoningEffort: threadReasoningEffort,
                    researchDepth: effectiveResearchDepth,
                    searchMode: effectiveSearchMode,
                    shouldAutoContinue: isAutoContinue,
                    toolNames: Object.keys(tools),
                    toolPermissionKeys: toolResult.permissionKeys,
                },
                streamId,
                threadId,
                userId,
            });

            // Post-stream work: timing and memory extraction, then follow-ups.
            afterRun(ctx, {
                extractMemory: runContext.memoryEnabled,
                firstTokenTime,
                knowledgeSources: runContext.knowledgeSources,
                prompt,
                retrievedMemories: runContext.retrievedMemories,
                savedMessages: result.savedMessages,
                ...(invokedSkill && { skill: { name: `/${invokedSkill.slug}`, ...(invokedSkill.skillId && { id: invokedSkill.skillId }) } }),
                threadId,
                ...(runContext.prefs.timezone && { timeZone: runContext.prefs.timezone }),
                timingStart,
                userId,
            });

            void ctx.scheduler.runAfter(0, internal.chat.functions.generateFollowupSuggestionsForThread, {
                threadId,
                userId,
            });

            await setThreadStatus(ctx, threadId, "active");

            streamLogger.debug(`[BgAgent] Execution complete`, {
                elapsedMs: Date.now() - startTime,
                messageId,
                streamId,
                threadId,
            });
        } catch (error) {
            streamLogger.error(`[BgAgent] Error:`, error);

            // Our own validation text (skill disabled, required variable missing) is
            // written for the user; everything else goes through the one mapping the
            // persisted message uses too. The raw error is in the log line above.
            const customEndpoint = parseCustomModelId(model) !== null;
            let safeMessage =
                isAgentRunError(error, "skill") || isAgentRunError(error, "local-endpoint") || isAgentRunError(error, "plan-required")
                    ? error.message
                    : toUserFacingError(error, { customEndpoint });

            if (customEndpoint && isAgentRunError(error, "custom-endpoint")) {
                safeMessage = "The custom endpoint for this model was removed or disabled. Pick another model or re-enable it in Settings → API Keys.";
            }

            await failRun(ctx, { safeMessage, streamId, threadId, threadStatus: "error" });
        } finally {
            await closeMCPClients(mcpClients);
        }
    });

/**
 * Resume a run that paused on a tool-approval request, once
 * `respondToToolApproval` has claimed the snapshot and opened `streamId`.
 */
export const continueAfterToolApproval = internalAction
    .input({
        /** The user's answer to an approved `askUser` call — its tool result (`chat/ask-user.ts`). */
        answer: v.optional(v.string()),
        approvalId: v.string(),
        approved: v.boolean(),
        config: vToolRunConfig,
        /** For a denied call: what the model is told instead of the default denial (a dismissed question). */
        denyReason: v.optional(v.string()),
        streamId: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .action(async ({ args: { answer, approvalId, approved, config, denyReason, streamId, threadId, userId }, ctx }) => {
        // Enqueued on the jobs queue (at-least-once): only the claiming delivery resumes the run.
        if (!(await ctx.runMutation(internal.chat.streaming.persistent.library.claimStreamRun, { streamId: streamId as Id<"persistentStreams"> }))) {
            streamLogger.warn(`[ToolApproval] Stream ${streamId} already claimed — ignoring a redelivered continuation`);

            return;
        }

        try {
            // A group-chat participant paused: resume it, then the rest of its turn.
            if (config.group) {
                await continueGroupAfterToolApproval(ctx, {
                    answer,
                    approvalId,
                    approved,
                    config: { ...config, group: config.group },
                    denyReason,
                    streamId,
                    threadId,
                    userId,
                });

                return;
            }

            await resumeApprovedRun(ctx, { answer, approvalId, approved, config, denyReason, streamId, threadId, userId });

            await setThreadStatus(ctx, threadId, "active");
        } catch (error) {
            streamLogger.error(`[ToolApproval] Continuation failed:`, error);

            const safeMessage = isAgentRunError(error, "stale-approval")
                ? "This tool request is no longer pending."
                : "An error occurred while continuing the response. Please try again.";

            await failRun(ctx, { safeMessage, streamId, threadId, threadStatus: "active" });
        }
    });
