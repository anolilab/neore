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
import { isThreadLocked } from "../lib/thread-lock";
import { findSkillCommand, parseSkillCommand, resolveReasoningEffort, resolveSkillModel } from "../skills/slash-command";
import { handOffToGoalReview, noteGoalPaused, otherGoalHoldsThread } from "./goals/execute";
import { GOAL_CONTINUATION_AGENT } from "./goals/shared";
import { continueGroupAfterToolApproval, runGroupTurn } from "./group/run";
import {
    afterRun,
    AgentRunError,
    buildRunStreamArgs,
    createRunSteering,
    endStoppedRun,
    failRun,
    finishRun,
    isAgentRunError,
    loadRunContext,
    memoryToCarry,
    resolveBackupModelId,
    resolveRunModel,
    resumeApprovedRun,
    setDispatchOrigin,
    setResearchDepth,
    setThreadStatus,
    stampSavedToolCalls,
} from "./lib/agent-run";
import { buildAgentTools } from "./lib/agent-tools";
import { getMaxSteps } from "./lib/auto-continue";
import { gatewayFetch } from "../lib/services";
import getAgent from "./lib/get-agent";
import { injectsSkillText } from "./lib/low-risk-approval";
import { closeMCPClients } from "./lib/mcp-tools";
import { pipeToPersistentChunks, type PipedStream, stopWhenStopped, toolProgressSink } from "./lib/persist-stream";
import classifyQuery from "./lib/query-classifier";
import detectTaskComplexity, { type TaskAnalysis } from "./lib/task-detector";
import type { SearchMode } from "./lib/tool-builder";
import { vToolRunConfig } from "./lib/tool-run-config";
import { pauseOnRateLimit } from "./lib/pause-run";
import { scheduleRepliesUsage } from "./lib/pause-usage";
import { runStreamingAgentFields } from "./lib/streaming-run-args";
import { toUserFacingError } from "./lib/user-facing-error";

export const runStreamingAgent = internalAction
    .input(runStreamingAgentFields)
    .action(
        async ({
            args: { isAnonymous, messageId, organizationId, origin, resume, skill: goalSkill, streamId, streamingConfig, threadId, userId, userPrompt },
            ctx,
        }) => {
            // Everything before the first token is on the user's wait, so the reads
            // that need nothing but the job's own arguments start together, WITH
            // the claim. They are queries: a redelivery that loses the claim reads
            // and discards, and generates nothing.
            const isSkillCommand = goalSkill !== undefined || (userPrompt !== undefined && Boolean(parseSkillCommand(userPrompt)));
            const reads = Promise.all([
                // Full access, or a locked chat the stream was started under (`streamRunThread`).
                ctx.runQuery(internal.chat.streaming.streamRunThread, { streamId: streamId as Id<"persistentStreams">, userId }),
                // Group chat: its participants take the turn (`group/run.ts`) — unless
                // the user invoked one skill directly with `/<slug>`, or this job resumes a
                // paused run, which finishes the one agent's reply even if the chat became a
                // group chat meanwhile (a group turn would answer the prompt a second time).
                isSkillCommand || resume !== undefined
                    ? null
                    : ctx.runQuery(internal.chat.group.functions.getGroupRunConfig, { organizationId, threadId, userId }),
                // Raw row: the stream above was admitted under the thread's lock state (`streamRunThread`).
                ctx.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: [messageId as Id<"messages">] }),
                ctx.runQuery(internal.auth.functions.getAgentModulePreferencesQuery, { userId }),
            ]);

            // Settled either way below; this only keeps a failed read from being
            // reported as unhandled while the claim is still being awaited.
            reads.catch(() => undefined);

            // Enqueued on the jobs queue, which delivers at least once: only the
            // delivery that claims the stream may generate into it. The job that
            // resumes a run paused on a rate limit (`resume`) claims that pause
            // instead, and learns which row the run continues from.
            let resumedFrom: string | undefined;
            // What the run did before its pauses: the reply rows it saved, the steps it ran, what its usage record needs.
            let before: { replyRowIds: string[]; skill?: { id?: string; name: string }; stepsUsed: number; timeZone?: string } = {
                replyRowIds: [],
                stepsUsed: 0,
            };

            if (resume === undefined) {
                if (!(await ctx.runMutation(internal.chat.streaming.persistent.library.claimStreamRun, { streamId: streamId as Id<"persistentStreams"> }))) {
                    streamLogger.warn(`[BgAgent] Stream ${streamId} already claimed — ignoring a redelivered run`);

                    return;
                }
            } else {
                const claim = await ctx.runMutation(internal.chat.streaming.persistent.library.claimRunResume, {
                    pauseId: resume,
                    streamId: streamId as Id<"persistentStreams">,
                });

                if (!claim) {
                    streamLogger.warn(`[BgAgent] Pause ${resume} of stream ${streamId} is not open — ignoring a resume that lost the claim`);

                    return;
                }

                resumedFrom = claim.from;
                before = claim;
            }

            // The reply's earlier rows, so the run records ONE reply covering them and its own steps. Best-effort: usage is not worth the run.
            const priorRows =
                before.replyRowIds.length > 0
                    ? await ctx
                          .runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: before.replyRowIds as Id<"messages">[] })
                          .then((rows) => rows.filter((row) => row !== null))
                          .catch(() => [])
                    : [];

            const startTime = Date.now();
            let mcpClients: import("@ai-sdk/mcp").MCPClient[] = [];
            // The rows this invocation has saved so far, for a failure that reaches the outer catch before `recordRun`.
            let savedSoFar: () => typeof priorRows = () => [];

            const { customSystemPrompt, model: requestedModel, reasoningEffort, statelessMode } = streamingConfig;
            // Reassigned once, when an invoked skill names a preferred model.
            let model = requestedModel;
            // Set once the run has saved rows: a run that fails still leaves the record of the calls the quick check approved.
            let stampSavedCalls: (() => Promise<void>) | undefined;

            try {
                streamLogger.debug(`[BgAgent] Starting background agent execution`, {
                    messageId,
                    streamId,
                    threadId,
                });

                const [thread, groupConfig, sseMessages, agentModulePrefs] = await reads;

                // The thread, read with the caller's access checked.
                if (!thread) {
                    // Through `failRun`, not a bare chunk: the thread was set to `running` when the run started,
                    // and only `failRun` takes it back out.
                    await failRun(ctx, { safeMessage: "Thread not found", streamId, threadId, threadStatus: "active" });

                    return;
                }

                // A goal's later round was queued with the verdict; one that ended since (a new message, Stop) closes its stream and never runs.
                if (
                    sseMessages?.[0]?.agentName === GOAL_CONTINUATION_AGENT &&
                    !(await ctx.runMutation(internal.chat.goals.internal.closeStaleGoalRound, { messageId, streamId: streamId as Id<"persistentStreams"> }))
                ) {
                    streamLogger.warn(`[BgAgent] Stream ${streamId} belongs to a goal that ended — not run`);

                    return;
                }

                if (groupConfig) {
                    // A goal reviews one agent's turns; a group turn has several speakers.
                    // Only the goal this run's own message started: a newer goal (a skill in the same group chat) is not this run's.
                    await ctx.runMutation(internal.chat.goals.internal.endGoalsForThread, {
                        reason: "unsupported",
                        streamId: streamId as Id<"persistentStreams">,
                        threadId: threadId as Id<"threads">,
                    });
                    await runGroupTurn(
                        ctx,
                        { isAnonymous: isAnonymous === true, messageId, organizationId, origin, streamId, streamingConfig, threadId, userId, userPrompt },
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
                    admittedRun: true,
                    customSystemPrompt,
                    promptText: prompt,
                    researchDepth: streamingConfig.researchDepth,
                    threadId,
                    threadLanguage: thread.language,
                    userId,
                });

                runContextPromise.catch(() => undefined);

                const skillCommand = goalSkill ?? findSkillCommand(userPrompt, message?.message?.content, prompt);
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

                // The one answer the quick check reads: at the first call from the tools below, and from the snapshot a pause leaves.

                const untrustedContext = runContextPromise.then((context) => context.untrustedContext || injectsSkillText(skillRun));

                untrustedContext.catch(() => undefined);

                // A live bot keeps its pinned model (`/chat/start`); a skill's preferred model does not replace it.
                const liveBot = thread?.botId ? await ctx.runQuery(internal.bots.functions.getBotForRun, { botId: thread.botId, userId }) : null;

                model = liveBot
                    ? requestedModel
                    : resolveSkillModel(requestedModel, invokedSkill?.config?.preferredModel, (id) => MODEL_LOOKUP.get(id), isAnonymous === true);

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
                              // Admitted by `streamRunThread` above: the knowledge tool may reach this chat's own files.
                              admittedRun: true,
                              autoMediaEnrichment: agentModulePrefs.autoMediaEnrichment,
                              // Interactive: the user's devices, if this thread may reach them.
                              deviceThreadId: threadId,
                              mcpProgress: toolProgressSink(ctx, streamId),
                              mcpServerNames: streamingConfig.mcpServerNames,
                              model,
                              ...(origin === "outside_agent" && { origin }),
                              searchMode: effectiveSearchMode,
                              skillTools: invokedSkill?.config
                                  ? { additionalTools: invokedSkill.config.additionalTools, disabledTools: invokedSkill.config.disabledTools }
                                  : undefined,
                              threadId,
                              // The tools are built while the context loads; the quick check reads this at the first call.
                              untrustedContext: untrustedContext.catch(() => true),
                              userId,
                          })
                        : { autoApprovals: {}, mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools: {} },
                    runContextPromise,
                ]);

                mcpClients = toolResult.mcpClients;

                const { tools } = toolResult;
                const { contextParts, prefs, researchDepth: effectiveResearchDepth, threadSettings: appThread } = runContext;

                setResearchDepth(ctx, effectiveResearchDepth);
                setDispatchOrigin(ctx, origin ?? "lead");

                // Build agent
                const isAutoContinue = streamingConfig.shouldAutoContinue === true;
                // The step cap is for the whole reply: a run resumed after a pause gets what the earlier steps left.
                const maxSteps = Math.max(1, getMaxSteps(isAutoContinue) - before.stepsUsed);

                const backupModelId = await resolveBackupModelId(ctx, userId, prefs.backupModel, model, agentModulePrefs.modelFilterRules ?? {});
                const agent = await getAgent(model, {
                    agentMode,
                    backupModelId,
                    customProvider,
                    enabledSkills: skillRun.enabledSkills.length > 0 ? skillRun.enabledSkills : undefined,
                    gateway: gatewayFetch(ctx),
                    language: prefs.language,
                    location: prefs.location,
                    maxSteps,
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
                const streamTextArgs: any = buildRunStreamArgs({
                    backupModelId,
                    hasTools: Object.keys(tools).length > 0,
                    model,
                    reasoningEffort: threadReasoningEffort,
                    shouldAutoContinue: isAutoContinue,
                });

                if (threadStatelessMode) {
                    streamTextArgs.prompt = prompt;
                } else {
                    // A resumed run continues from the last row it saved before the pause, so its rows land under that row.
                    streamTextArgs.promptMessageId = resumedFrom ?? messageId;
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

                // Messages the user sends into the reply while it streams (`chat/steering.ts`).
                const steering = createRunSteering(ctx, { streamId, threadId, userId });

                // Stream text
                // Admitted by `streamRunThread` above: the run reads its context without a proof.
                // Aborted only after a sidebar stop's reply is saved (see the catch below).
                const stopping = new AbortController();

                streamTextArgs.abortSignal = stopping.signal;
                // The steps this invocation finished: a pause carries the count to its resume.
                const stepsFinished = { count: 0 };

                streamTextArgs.stopWhen = [
                    ...stopWhenStopped(ctx, streamId, maxSteps),
                    ({ steps }: { steps: ReadonlyArray<unknown> }) => {
                        stepsFinished.count = steps.length;

                        return false;
                    },
                ];
                const result = await threadObject.streamText(streamTextArgs, {
                    admittedRun: true,
                    statelessMode: threadStatelessMode,
                    takeSteer: steering.takeSteer,
                });

                savedSoFar = () => result.savedMessages ?? [];

                // Write chunks to persistent storage (DB only, no HTTP response)
                const timingStart = Date.now();
                let piped: PipedStream;

                const skill = invokedSkill ? { name: `/${invokedSkill.slug}`, ...(invokedSkill.skillId && { id: invokedSkill.skillId }) } : undefined;

                stampSavedCalls = async () =>
                    await stampSavedToolCalls(ctx, {
                        autoApprovals: toolResult.autoApprovals,
                        mcpLabels: toolResult.mcpLabels,
                        savedMessages: result.savedMessages,
                        userId,
                    });

                // A sidebar stop during the run ends it here, with the reply it still owed saved (`endStoppedRun`).
                const recordRun = async (extra: Pick<Parameters<typeof afterRun>[1], "botId" | "extractMemory" | "firstTokenTime" | "prompt">) => {
                    await afterRun(ctx, {
                        knowledgeSources: runContext.knowledgeSources,
                        retrievedMemories: runContext.retrievedMemories,
                        // A run resumed after a pause records the whole reply: its earlier rows come first, so the key is the reply's first row.
                        savedMessages: [...priorRows, ...(result.savedMessages ?? [])],
                        ...(skill && { skill }),
                        steeredTexts: steering.steeredTexts(),
                        summarizeThread: runContext.prefs.threadSummariesEnabled,
                        threadId,
                        ...(runContext.prefs.timezone && { timeZone: runContext.prefs.timezone }),
                        timingStart,
                        userId,
                        ...extra,
                    });
                };
                const stoppedAt = async (error: unknown) => {
                    await endStoppedRun(ctx, error, {
                        continuation: false,
                        order: result.order,
                        promptMessageId: result.promptMessageId,
                        result,
                        stamp: { autoApprovals: toolResult.autoApprovals, mcpLabels: toolResult.mcpLabels, userId },
                        stop: stopping,
                        streamId,
                    });

                    // The steps that finished before the stop are a reply like any other on the usage page; nothing is mined for memory.
                    await recordRun({ extractMemory: false, firstTokenTime: undefined, prompt: "" });
                };

                try {
                    piped = await pipeToPersistentChunks(ctx, streamId, result.fullStream, { steeredBefore: steering.steeredBefore });
                } catch (error) {
                    // A provider rate limit pauses the run and resumes it at the provider's retry time, as a queued job:
                    // nothing here waits. A stateless run keeps no rows to continue from, so it fails as before.
                    const paused =
                        !threadStatelessMode &&
                        (await pauseOnRateLimit(ctx, {
                            error,
                            progress: () => {
                                const saved = result.savedMessages ?? [];

                                return {
                                    from: saved.at(-1)?._id ?? resumedFrom ?? messageId,
                                    placeholderId: result.getPendingMessageId(),
                                    replyRowIds: saved.map((row) => row._id),
                                    stepsUsed: stepsFinished.count,
                                };
                            },
                            reply: { ...(skill && { skill }), ...(runContext.prefs.timezone && { timeZone: runContext.prefs.timezone }) },
                            run: {
                                isAnonymous,
                                messageId,
                                organizationId,
                                origin,
                                ...(goalSkill && { skill: goalSkill }),
                                streamId,
                                streamingConfig,
                                threadId,
                                userId,
                                userPrompt,
                            },
                            settle: async () => await result.consumeStream(),
                            streamId,
                        }));

                    // The steps that finished are not recorded yet: the reply is one reply, recorded when the run ends (or, if
                    // it never resumes, by whatever ends it).
                    if (paused) {
                        return;
                    }

                    await stoppedAt(error);

                    return;
                }

                const { firstTokenTime, pending, unsaved } = piped;

                // Wait for the agent to save the final message
                await result.consumeStream();

                // No token counts here: awaiting `totalUsage` on the live path could
                // reject or stall a run that otherwise finished; a log line must not.
                ctx.log.event("chat.run_streaming_agent", { autoContinue: isAutoContinue, model });

                // Record the approval snapshot (if the run paused) and flush. The
                // snapshot is what the continuation rebuilds this exact run from.
                // A locked chat's content is never mined into memory, and neither is a goal round's instruction: it is the
                // goal plus a reviewer's note drawn from tool output, not something the user said.
                const extractMemory = runContext.memoryEnabled && !isThreadLocked(thread) && sseMessages?.[0]?.agentName !== GOAL_CONTINUATION_AGENT;

                let finished: Awaited<ReturnType<typeof finishRun>>;

                try {
                    finished = await finishRun(ctx, {
                        autoApprovals: toolResult.autoApprovals,
                        mcpLabels: toolResult.mcpLabels,
                        pending,
                        savedMessages: result.savedMessages,
                        snapshot: {
                            autoMediaEnrichment: agentModulePrefs.autoMediaEnrichment,
                            ...(origin === "outside_agent" && { dispatchOrigin: origin }),
                            instructions: streamTextArgs.system ?? agent.options.instructions,
                            mcpServerNames: toolResult.mcpServerNames,
                            // A run that pauses extracts at the pause; its continuation extracts only the steers it takes.
                            memory: memoryToCarry({ botId: runContext.botId, extractMemory, prompt }),
                            model,
                            promptMessageId: messageId,
                            reasoningEffort: threadReasoningEffort,
                            researchDepth: effectiveResearchDepth,
                            searchMode: effectiveSearchMode,
                            shouldAutoContinue: isAutoContinue,
                            toolNames: Object.keys(tools),
                            toolPermissionKeys: toolResult.permissionKeys,
                            // A continuation does not reload the context, so the quick check reads this off the snapshot.
                            untrustedContext: await untrustedContext,
                        },
                        streamId,
                        threadId,
                        unsaved,
                        userId,
                    });
                } catch (error) {
                    // A stop landed after the pipe ended: the final write is refused, the owed text is saved.
                    await stoppedAt(error);

                    return;
                }

                // Post-stream work: timing and memory extraction, then follow-ups.
                await recordRun({
                    botId: runContext.botId,
                    extractMemory,
                    firstTokenTime,
                    prompt,
                });

                // A run that belongs to a goal is reviewed before the chat settles: the goal keeps the thread running
                // and holds the follow-ups back until it ends. A run paused on an approval is not finished yet.
                if (finished.paused) {
                    await noteGoalPaused(ctx, threadId);
                } else if ((await handOffToGoalReview(ctx, threadId, { messageId })) || (await otherGoalHoldsThread(ctx, threadId, { messageId }))) {
                    // Its goal reviews it next; or its goal was replaced while it ran and the new goal owns the thread now.
                    return;
                }

                void ctx.scheduler.runAfter(0, internal.chat.functions.generateFollowupSuggestionsForThread, {
                    threadId,
                    userId,
                });

                await setThreadStatus(ctx, threadId, "active", { awaitingInput: finished.awaitingInput, replied: !finished.paused });

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

                await failRun(ctx, { safeMessage, stamp: stampSavedCalls, streamId, threadId, threadStatus: "error" });

                // A run that failed after its pause still answered with the steps from before it, and with any it saved since: those are its reply.
                if (priorRows.length > 0) {
                    scheduleRepliesUsage(ctx.scheduler as never, [...priorRows, ...savedSoFar()], {
                        at: Date.now(),
                        userId,
                        ...(before.skill && { skill: before.skill }),
                        ...(before.timeZone && { timeZone: before.timeZone }),
                    });
                }
            } finally {
                await closeMCPClients(mcpClients);
            }
        },
    );

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
            // A locked chat resumes only under a stream started after its lock (`streamRunThread`).
            // Checked AFTER the claim, inside the try: a refusal or a failed read must close the
            // claimed stream and leave the thread out of `running`, not strand both.
            if (!(await ctx.runQuery(internal.chat.streaming.streamRunThread, { streamId: streamId as Id<"persistentStreams">, userId }))) {
                streamLogger.warn(`[ToolApproval] Stream ${streamId} belongs to a locked or unreachable chat — not resumed`);

                await failRun(ctx, {
                    safeMessage: "This chat can no longer continue the response.",
                    streamId,
                    threadId,
                    threadStatus: "active",
                });

                return;
            }

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

            // The gate above admitted this continuation, so its knowledge search may read the chat's own files.
            const resumed = await resumeApprovedRun(
                ctx,
                { answer, approvalId, approved, config, denyReason, streamId, threadId, userId },
                { admittedRun: true, steerable: true },
            );

            // The run a goal was waiting on ended here, once nothing more is pending (see `runStreamingAgent`).
            if (resumed.paused) {
                await noteGoalPaused(ctx, threadId);
            } else if (
                (!resumed.stopped && (await handOffToGoalReview(ctx, threadId, { streamId }))) ||
                (await otherGoalHoldsThread(ctx, threadId, { streamId }))
            ) {
                return;
            }

            await setThreadStatus(ctx, threadId, "active", { awaitingInput: resumed.awaitingInput, replied: !resumed.paused && !resumed.stopped });

            if (resumed.stopped) {
                await ctx.runMutation(internal.agent.threads.endStoppedPause, { threadId: threadId as Id<"threads"> });
            }
        } catch (error) {
            streamLogger.error(`[ToolApproval] Continuation failed:`, error);

            const safeMessage = isAgentRunError(error, "stale-approval")
                ? "This tool request is no longer pending."
                : "An error occurred while continuing the response. Please try again.";

            await failRun(ctx, { safeMessage, streamId, threadId, threadStatus: "active" });
        }
    });
