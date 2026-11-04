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
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { estimateTokensFromCharacters, hasActiveFilters, MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { autoCompactBeforeReply } from "../agent/thread-compaction";
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
    discardRunSecrets,
    endStoppedRun,
    failRun,
    finishRun,
    isAgentRunError,
    loadRunContext,
    memoryToCarry,
    readRunPlan,
    resolveBackupModelId,
    resolveRunModel,
    resumeApprovedRun,
    setDispatchOrigin,
    setResearchDepth,
    setRunStartedBy,
    setThreadStatus,
    readResumeInterruptedRuns,
    stampSavedToolCalls,
} from "./lib/agent-run";
import { buildAgentTools } from "./lib/agent-tools";
import { chargeCompactionCall } from "./lib/compaction-quota";
import { getMaxSteps, getModelContextWindow } from "./lib/auto-continue";
import { RUN_BEAT_MS } from "./lib/interrupted-run";
import { createToolRunMarker } from "./lib/mark-tool-runs";
import { isRunReplaced } from "./lib/run-epoch";
import { gatewayFetch } from "../lib/services";
import getAgent from "./lib/get-agent";
import { loadModelFilterRules, MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE } from "./lib/model-filter-rules";
import { defaultModelUnderRules, readsImagesAndCallsTools } from "../lib/utility-model";
import { injectsSkillText } from "./lib/low-risk-approval";
import { closeMCPClientsThenSettle } from "./lib/mcp-tools";
import { pipeToPersistentChunks, type PipedStream, stopWhenStopped, toolProgressSink } from "./lib/persist-stream";
import { MAX_LENGTH } from "../lib/validators";
import { resolveAutoModel, shouldRouteAuto } from "./lib/auto-model";
import classifyQuery from "./lib/query-classifier";
import detectTaskComplexity, { type TaskAnalysis } from "./lib/task-detector";
import { getToolsForModelAndMode, type SearchMode } from "./lib/tool-builder";
import { getAgentForUser } from "./lib/thread-helpers";
import { vToolRunConfig } from "./lib/tool-run-config";
import { vAskUserAnswers } from "./tools/ask-user-validators";
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
            // Which run holds the stream (`lib/run-epoch.ts`): 0 for the first claim, the claim's number for a resume.
            let runEpoch = 0;
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
                runEpoch = claim.epoch;
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
            // The work an abort of the model call started: the run does not end before it has landed.
            let settleAbort: () => Promise<void> = async () => undefined;

            const { customSystemPrompt, model: requestedModel, reasoningEffort, statelessMode } = streamingConfig;
            // Reassigned once, when an invoked skill names a preferred model.
            let model = requestedModel;
            // Set once the run has saved rows: a run that fails still leaves the record of the calls the quick check approved.
            let stampSavedCalls: (() => Promise<void>) | undefined;
            // Aborted when a newer run took the stream (`onReplaced`) or a sidebar stop ends this one.
            const stopping = new AbortController();
            let beat: ReturnType<typeof setInterval> | undefined;
            let replaced = false;
            // A newer run holds the stream (this one was slow, not dead): it stops without writing anything more.
            const onReplaced = () => {
                if (!replaced) {
                    streamLogger.warn(`[BgAgent] Stream ${streamId} was taken over by a newer run — stopping this one`);
                }

                replaced = true;
                clearInterval(beat);
                stopping.abort();
            };
            const wasReplaced = (error: unknown) => replaced || isRunReplaced(error);
            // The beat of a run that may be resumed after its worker dies (`streaming/persistent/interrupted.ts`). Idempotent.
            const beatOnce = () => {
                ctx.runMutation(internal.chat.streaming.persistent.interrupted.beatRun, {
                    epoch: runEpoch,
                    streamId: streamId as Id<"persistentStreams">,
                }).catch((error: unknown) => {
                    if (isRunReplaced(error)) {
                        onReplaced();

                        return;
                    }

                    // A beat that does not land is not fatal (the next one may), but a run that stops beating is read as dead.
                    streamLogger.warn(`[BgAgent] Stream ${streamId}: a heartbeat failed:`, error);
                });
            };
            const startBeat = () => {
                beat ??= setInterval(beatOnce, RUN_BEAT_MS);
            };
            // Every tool call is marked on the stream until its step is saved: a worker that dies inside one is not resumed,
            // unless the tool is safe to repeat (`repeatable-tools.ts`).
            // Whether a worker death would be answered by a resume: only then must a tool refuse to run without a confirmed mark.
            // A resumed run is resumable by definition (its watchdog chain exists); a first run becomes so when it registers.
            let resumableRun = resume !== undefined;
            const toolRuns = createToolRunMarker(ctx, { epoch: runEpoch, isResumable: () => resumableRun, onReplaced, streamId });

            try {
                streamLogger.debug(`[BgAgent] Starting background agent execution`, {
                    messageId,
                    streamId,
                    threadId,
                });

                // A resumed run beats from the claim on: its setup (MCP, retrieval, memory) can outlast the stale window, and a
                // watchdog that read that silence as a death would resume the run beside itself.
                if (resume !== undefined) {
                    startBeat();
                }

                const [thread, groupConfig, sseMessages, agentModulePrefs] = await reads;

                // The thread, read with the caller's access checked.
                if (!thread) {
                    // Through `failRun`, not a bare chunk: the thread was set to `running` when the run started,
                    // and only `failRun` takes it back out.
                    await failRun(ctx, { runEpoch, safeMessage: "Thread not found", streamId, threadId, threadStatus: "active" });

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

                // A failed preference read answers defaults, not the user's choices: a ZDR, region or provider rule may be
                // hiding behind them, so the run is refused rather than sent out unrestricted.
                if (agentModulePrefs.readFailed === true) {
                    await failRun(ctx, { runEpoch, safeMessage: MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE, streamId, threadId, threadStatus: "error" });

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

                // The model before Auto picks one: a route is always made from it, so a second route starts from the same place.
                const preRouteModel = model;
                // "Auto": this send runs on the one model the gateway's routing picks, named like any other pick below. A bot's or a
                // skill's model stands, and so does a switched thread's agent (`shouldRouteAuto`). A resume continues a reply that
                // already has a model: the one recorded in its job arguments below.
                let routedModel: string | undefined;
                // The plan Auto authorized its route with (the run's organization). The model gate checks the same plan.
                let autoPlan: Awaited<ReturnType<typeof readRunPlan>> | undefined;

                // A goal runs on the model it starts with, every round: its continuation rounds are machine-written and read the
                // goal's saved model, so routing its first round alone would leave the later rounds on another model.
                const routeAuto = async (): Promise<void> => {
                    const routes =
                        resume === undefined &&
                        goalSkill === undefined &&
                        sseMessages?.[0]?.agentName !== GOAL_CONTINUATION_AGENT &&
                        shouldRouteAuto({
                            currentModel: preRouteModel,
                            isAnonymous: isAnonymous === true,
                            pinnedByBotOrSkill: liveBot !== null || Boolean(invokedSkill?.config?.preferredModel),
                            prompt,
                            requestedModel,
                            thread,
                            userId,
                        });

                    if (!routes) {
                        return;
                    }

                    // The route is sized for what the model will receive: the history, the instructions it is given (the agent's
                    // own, the loaded context and the skill's), and the built-in tools. MCP tools are added later and not counted.
                    const fallbackTools = getToolsForModelAndMode(
                        preRouteModel,
                        "chat",
                        invokedSkill?.config
                            ? { additionalTools: invokedSkill.config.additionalTools, disabledTools: invokedSkill.config.disabledTools }
                            : undefined,
                        { autoMediaEnrichment: agentModulePrefs.autoMediaEnrichment },
                    );

                    routedModel = await resolveAutoModel(ctx, {
                        conversation: async () => {
                            const [history, run, fallbackAgent] = await Promise.all([
                                ctx.runQuery(internal.chat.auto_model_context.getAutoRouteContext, {
                                    promptMessageId: messageId,
                                    stateless: thread?.statelessMode ?? statelessMode,
                                    threadId: threadId as Id<"threads">,
                                }),
                                runContextPromise,
                                getAgentForUser(ctx, userId, preRouteModel, thread?.language),
                            ]);
                            const systemCharacters =
                                (fallbackAgent.options.instructions ?? "").length +
                                run.contextParts.join("\n\n").length +
                                (invokedSkill?.instructions.length ?? 0);

                            return {
                                contextTokens: history.contextTokens + Math.ceil(estimateTokensFromCharacters(systemCharacters)),
                                files: history.files,
                                images: history.images,
                            };
                        },
                        // The thread's own model is the fallback: a send that names another model must not run on it.
                        fallbackModel: thread?.model ?? preRouteModel,
                        filterRules: agentModulePrefs.modelFilterRules ?? undefined,
                        plan: async () => {
                            autoPlan = await readRunPlan(ctx, userId, organizationId);

                            return autoPlan;
                        },
                        prompt,
                        threadId,
                        toolCount: Object.keys(fallbackTools).length,
                        userId,
                    });
                    model = routedModel;
                };

                // The route is chosen before compaction, so the auto-compact threshold is measured against the window of the
                // model the reply will run on. A compaction that changes the context sends the route through again.
                await routeAuto();

                // Auto-compact (`agent/thread-compaction.ts`): a context past the owner's threshold is compacted before
                // this reply reads it, measured against the window of the model the route picked. A resumed run continues a
                // reply that already read its context.
                if (resume === undefined && !statelessMode) {
                    const compacted = await autoCompactBeforeReply(ctx, {
                        anchorMessageId: messageId as Id<"messages">,
                        // Charged like a manual `/compact` before its first summarising call; a refusal leaves the reply uncompacted.
                        beforeFirstCall: async () => {
                            // The run's plan, organization included: the user's own plan alone would charge an organization's member to the free bucket.
                            const [flags, runPlan] = await Promise.all([
                                ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId }),
                                readRunPlan(ctx, userId, organizationId),
                            ]);

                            await chargeCompactionCall(ctx, { _id: userId, isAnonymous: flags.isAnonymous, plan: runPlan.plan, role: flags.role });
                        },
                        contextWindow: getModelContextWindow(model),
                        // Stop and a newer run both end it, so the reply does not wait on a compaction nobody reads.
                        signal: stopping.signal,
                        threadId: threadId as Id<"threads">,
                        thresholdPercent: agentModulePrefs.autoCompactThreshold,
                        userId,
                    });

                    if (compacted) {
                        await routeAuto();
                    }
                }

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

                // The Workers AI default cannot keep to a region rule: a user with one runs on a default their rules allow, with
                // the plan grant (`loadModelFilterRules`) so a paid user may land on a paid model. Recorded like an Auto route,
                // so a resume continues on the same model even if the rules changed meanwhile.
                if (resume === undefined && model === DEFAULT_CHAT_MODEL && hasActiveFilters(agentModulePrefs.modelFilterRules ?? undefined)) {
                    const standIn = defaultModelUnderRules(model, await loadModelFilterRules(ctx, userId), readsImagesAndCallsTools);

                    if (standIn !== model) {
                        model = standIn;
                        routedModel = standIn;
                    }
                }

                // A custom endpoint gets no tools (built-in or MCP) unless the user
                // said its models support them.
                const { allowTools, customProvider } = await resolveRunModel(ctx, model, userId, autoPlan);

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
                              mcpProgress: toolProgressSink(ctx, streamId, runEpoch),
                              mcpServerNames: streamingConfig.mcpServerNames,
                              model,
                              // A thread's stored organization wins; the run's own caps a thread that has none.
                              organizationId: organizationId ?? null,
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
                        : { autoApprovals: {}, mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, repeatable: [], tools: {} },
                    runContextPromise,
                ]);

                mcpClients = toolResult.mcpClients;

                const tools = toolRuns.wrap(toolResult.tools, new Set(toolResult.repeatable));
                const { contextParts, prefs, researchDepth: effectiveResearchDepth, threadSettings: appThread } = runContext;

                setResearchDepth(ctx, effectiveResearchDepth);
                setDispatchOrigin(ctx, origin ?? "lead");
                // A write collaborator's turn runs as the collaborator: `startedBy` is what its continuation, run as the owner, still knows.
                setRunStartedBy(ctx, userId);

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
                // A resumed run continues stored rows, so it keeps the stateful mode it registered with: a thread switched to
                // stateless meanwhile would otherwise send the original prompt alone and restart the reply.
                const threadStatelessMode = resumedFrom === undefined ? (appThread?.statelessMode ?? statelessMode) : false;

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

                // The job's own arguments: what a pause or an interrupted run's resume re-enters the job with.
                const runArgs = {
                    isAnonymous,
                    messageId,
                    organizationId,
                    origin,
                    ...(goalSkill && { skill: goalSkill }),
                    streamId,
                    streamingConfig: routedModel === undefined ? streamingConfig : { ...streamingConfig, model: routedModel },
                    threadId,
                    userId,
                    userPrompt,
                };

                const skill = invokedSkill ? { name: `/${invokedSkill.slug}`, ...(invokedSkill.skillId && { id: invokedSkill.skillId }) } : undefined;

                // A run with rows to continue from can be resumed when its worker dies: it registers and beats while it lives.
                // A stateless run keeps no rows, so it is not.
                if (!threadStatelessMode) {
                    try {
                        // Read on the person's own shard: this one may be a thread owner's, which has no row for a collaborator.
                        const resumable = await readResumeInterruptedRuns(userId);

                        await ctx.runMutation(internal.chat.streaming.persistent.interrupted.registerResumableRun, {
                            epoch: runEpoch,
                            labels: toolResult.mcpLabels,
                            reply: { ...(skill && { skill }), ...(runContext.prefs.timezone && { timeZone: runContext.prefs.timezone }) },
                            resumable,
                            run: runArgs,
                            streamId: streamId as Id<"persistentStreams">,
                        });
                        resumableRun = resumable || resume !== undefined;
                        startBeat();
                    } catch (error) {
                        // A newer run holds the stream: this one stops.
                        if (isRunReplaced(error)) {
                            onReplaced();

                            return;
                        }

                        // Any other failure (a busy shard, a timeout) must not cost the reply. But the answer may have been lost AFTER the
                        // registration committed, and then a watchdog is already looking at this run: it must keep beating (or it
                        // would be read as dead while it runs), and its tools must keep refusing to run unmarked. Beating a run that
                        // was not registered is harmless.
                        streamLogger.warn(`[BgAgent] Stream ${streamId} may not be registered for resuming; treating it as registered:`, error);
                        resumableRun = true;
                        beatOnce();
                        startBeat();
                    }
                }

                // Stream text
                // Admitted by `streamRunThread` above: the run reads its context without a proof.
                // Aborted only after a sidebar stop's reply is saved (see the catch below).
                streamTextArgs.abortSignal = stopping.signal;
                // The step's tool calls are accounted for once its rows are saved (the agent runs this after the save).
                streamTextArgs.onStepFinish = async () => {
                    await toolRuns.release();
                };
                // The steps this invocation finished: a pause carries the count to its resume.
                const stepsFinished = { count: 0 };

                streamTextArgs.stopWhen = [
                    ...stopWhenStopped(ctx, streamId, maxSteps),
                    ({ steps }: { steps: ReadonlyArray<unknown> }) => {
                        stepsFinished.count = steps.length;

                        return false;
                    },
                ];

                // Replaced while it set up (a long MCP connect, retrieval): it never starts the model call.
                if (replaced) {
                    return;
                }

                const result = await threadObject.streamText(streamTextArgs, {
                    admittedRun: true,
                    // The step's rows land only while this run holds the stream: `addMessages` checks it in its own transaction.
                    runHold: { epoch: runEpoch, streamId },
                    statelessMode: threadStatelessMode,
                    takeSteer: steering.takeSteer,
                });

                savedSoFar = () => result.savedMessages ?? [];
                settleAbort = result.settleAbort;

                // Write chunks to persistent storage (DB only, no HTTP response)
                const timingStart = Date.now();
                let piped: PipedStream;

                stampSavedCalls = async () =>
                    await stampSavedToolCalls(ctx, {
                        autoApprovals: toolResult.autoApprovals,
                        mcpLabels: toolResult.mcpLabels,
                        savedMessages: result.savedMessages,
                        userId,
                    });

                // A sidebar stop during the run ends it here, with the reply it still owed saved (`endStoppedRun`).
                const recordRun = async (extra: Pick<Parameters<typeof afterRun>[1], "botId" | "extractMemory" | "firstTokenTime" | "prompt">) => {
                    // The rows an earlier invocation of this reply saved (before a pause or a death) were never stamped with their
                    // tool names: this run's labels are the same ones. Idempotent, and never masks how the run ended.
                    if (priorRows.length > 0) {
                        await stampSavedToolCalls(ctx, {
                            autoApprovals: toolResult.autoApprovals,
                            mcpLabels: toolResult.mcpLabels,
                            savedMessages: priorRows,
                            userId,
                        }).catch((error: unknown) => {
                            streamLogger.warn("[BgAgent] Could not stamp the tool calls of the reply's earlier rows:", error);
                        });
                    }

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
                        threadId,
                    });

                    // The steps that finished before the stop are a reply like any other on the usage page; nothing is mined for memory.
                    await recordRun({ extractMemory: false, firstTokenTime: undefined, prompt: "" });
                };

                try {
                    piped = await pipeToPersistentChunks(ctx, streamId, result.fullStream, { runEpoch, steeredBefore: steering.steeredBefore });
                } catch (error) {
                    // The model call was aborted because a newer run took the stream: nothing of this run's is saved or ended.
                    if (wasReplaced(error)) {
                        onReplaced();

                        return;
                    }

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
                            run: runArgs,
                            runEpoch,
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
                        runEpoch,
                        savedMessages: result.savedMessages,
                        snapshot: {
                            autoMediaEnrichment: agentModulePrefs.autoMediaEnrichment,
                            ...(origin === "outside_agent" && { dispatchOrigin: origin }),
                            ...(organizationId && { organizationId }),
                            instructions: streamTextArgs.system ?? agent.options.instructions,
                            mcpServerNames: toolResult.mcpServerNames,
                            // A run that pauses extracts at the pause; its continuation extracts only the steers it takes.
                            memory: memoryToCarry({ botId: runContext.botId, extractMemory, prompt }),
                            model,
                            promptMessageId: messageId,
                            reasoningEffort: threadReasoningEffort,
                            // The reply is named by its first stream; every continuation inherits it.
                            replyKey: streamId,
                            researchDepth: effectiveResearchDepth,
                            searchMode: effectiveSearchMode,
                            shouldAutoContinue: isAutoContinue,
                            startedBy: userId,
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
                    if (wasReplaced(error)) {
                        onReplaced();

                        return;
                    }

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
                // A newer run holds the stream: this one's failure is not the reply's, and it ends nothing of theirs.
                if (wasReplaced(error)) {
                    onReplaced();

                    return;
                }

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

                const failed = await failRun(ctx, { runEpoch, safeMessage, stamp: stampSavedCalls, streamId, threadId, threadStatus: "error" });

                // A newer run holds the stream: its reply is the one that gets recorded, not this run's partial one.
                if (failed.replaced) {
                    return;
                }

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
                clearInterval(beat);
                await closeMCPClientsThenSettle(mcpClients, settleAbort);
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
        /** Files the answer carries; read as the owner by the continuation (`lib/ask-user-files.ts`). */
        answerFileIds: v.optional(v.array(v.string().max(MAX_LENGTH.id))),
        /** The answers to a multi-question `askUser` call, one per question: its tool result in place of `answer`. */
        answers: v.optional(vAskUserAnswers),
        approvalId: v.string(),
        approved: v.boolean(),
        config: vToolRunConfig,
        /** For a denied call: what the model is told instead of the default denial (a dismissed question). */
        denyReason: v.optional(v.string()),
        streamId: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .action(async ({ args: { answer, answerFileIds, answers, approvalId, approved, config, denyReason, streamId, threadId, userId }, ctx }) => {
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
                    answerFileIds,
                    answers,
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
                { answer, answerFileIds, answers, approvalId, approved, config, denyReason, streamId, threadId, userId },
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
                // The stop ended the reply for good, so what it kept through its pause goes with it.
                await discardRunSecrets(ctx, { streamId, threadId });
            }
        } catch (error) {
            streamLogger.error(`[ToolApproval] Continuation failed:`, error);

            const safeMessage = isAgentRunError(error, "stale-approval")
                ? "This tool request is no longer pending."
                : "An error occurred while continuing the response. Please try again.";

            await failRun(ctx, { safeMessage, streamId, threadId, threadStatus: "active" });
        }
    });
