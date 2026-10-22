import type { AgentConfig } from "@neore/ai/providers";

/**
 * Workflow Streaming HTTP Endpoint
 *
 * Provides SSE streaming for workflow execution, sending real-time updates
 * for node status changes and AI text generation.
 */
import { resolveWorkflowModel } from "@neore/ai/models";
import { streamText as streamTextAi } from "ai";
import type { HttpActionCtx } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { getCurrentUserInternal } from "../auth/lib/helper";
import type { BetterAuthUser } from "../auth/lib/types";
import { rateLimitTierOf } from "../chat/lib/daily-limit";
import { checkRateLimit, getRateLimitKey } from "../lib/rate-limiter";
import {
    accumulateUsage,
    createEmptyUsage,
    executeBranchNode,
    executeCodeNode,
    executeFileNode,
    executeOutputNode,
    type ExecutionContext,
    extractUrl,
    getExecutionOrder,
    getLastOutput,
    getLastOutputAsString,
    storeOutput,
    type TokenUsage,
    type WorkflowContent,
    type WorkflowNode,
} from "./core";
import { imageRequestArgs, runVideoNode, systemPromptFor, type VideoRunContext } from "./media-args";
import { type MediaCharge, withMediaCharge } from "./media-billing";
import { executeTextNode } from "./mention-targets";
import { buildExecutionContext, resolveRunAccount, workflowRunErrors } from "./run-setup";

let _agentsPromise: Promise<Record<string, AgentConfig>> | undefined;

const getAgents = (): Promise<Record<string, AgentConfig>> => {
    if (!_agentsPromise) {
        _agentsPromise = import("@neore/ai/providers").then(({ buildAgents }) => buildAgents());
    }

    return _agentsPromise;
};

// ============================================================================
// Types
// ============================================================================

interface StreamEvent {
    error?: string;
    nodeId?: string;
    nodeType?: string;
    output?: unknown;
    status?: string;
    text?: string;
    type: "status" | "node_start" | "node_complete" | "node_error" | "text_chunk" | "complete" | "error";
    usage?: TokenUsage;
}

// ============================================================================
// Streaming HTTP Action
// ============================================================================

const streamWorkflowHttpAction = async (context: HttpActionCtx, request: Request) => {
    const body = await request.json();
    const { projectId, variables } = body as { projectId: string; variables?: Record<string, string> };

    if (!projectId) {
        return Response.json({ error: "Missing projectId" }, { status: 400 });
    }

    let user: BetterAuthUser | undefined;

    try {
        user = await getCurrentUserInternal(context);
    } catch {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    if (!user) {
        return Response.json({ error: "User not found" }, { status: 401 });
    }

    const userId = user._id;

    // The same budget as `executeWorkflow`, resolved the way its `rateLimit()`
    // middleware resolves it: admins and the paid plan (the active
    // organization's tier, `auth/lib/plan.ts`) draw premium. It read the admin
    // role alone, so a paying user got the free budget here.
    const limited = await checkRateLimit(context, getRateLimitKey("workflow/execute", rateLimitTierOf(user)), { key: userId, throws: false });

    if (!limited.ok) {
        return Response.json({ error: "Too many workflow runs. Try again in a minute." }, { status: 429 });
    }

    const project = await context.runQuery(api.workflow.functions.getWorkflow, { projectId });

    if (!project) {
        return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    const workflowContent = project.workflowContent as WorkflowContent | undefined;

    if (!workflowContent || workflowContent.nodes.length === 0) {
        return Response.json({ error: "Workflow has no nodes" }, { status: 400 });
    }

    // Checked before any node runs, so a run that cannot finish never bills an earlier clip.
    const account = await resolveRunAccount(context, userId);
    const inputErrors = workflowRunErrors(account, workflowContent);

    if (inputErrors.length > 0) {
        return Response.json({ error: inputErrors.join("; ") }, { status: 400 });
    }

    const userProviderKeys = await context.runQuery(internal.auth.functions.getDecryptedProviderKeysQuery, { userId });

    const execution = await context.runMutation(internal.agent.workflow_executions.create, {
        projectId: projectId as Id<"projects">,
        status: "running",
        userId,
        workflowSnapshot: workflowContent,
    });

    const executionId = execution._id;

    // Set up SSE response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendEvent = async (event: StreamEvent) => {
        try {
            await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch (error) {
            console.error("Error writing to stream:", error);
        }
    };

    // Start streaming execution
    const executeWorkflow = async () => {
        const executionContext = buildExecutionContext({ account, content: workflowContent, runId: executionId, variables });

        const totalUsage = createEmptyUsage();

        try {
            await context.runMutation(internal.agent.workflow_executions.updateStatus, {
                executionId,
                startedAt: Date.now(),
                status: "running",
            });

            await sendEvent({ status: "running", type: "status" });

            const executionOrder = getExecutionOrder(workflowContent.nodes, workflowContent.edges);

            for (const nodeId of executionOrder) {
                const node = workflowContent.nodes.find((n) => n.id === nodeId);

                if (!node) {
                    continue;
                }

                await sendEvent({ nodeId, nodeType: node.type, type: "node_start" });

                const nodeExecution = await context.runMutation(internal.agent.node_executions.create, {
                    executionId,
                    nodeId,
                    nodeType: node.type,
                    startedAt: Date.now(),
                    status: "running",
                });

                try {
                    let output: unknown;
                    let usage: TokenUsage | undefined;

                    switch (node.type) {
                        case "advanced-controls": {
                            // Pass-through modifier: attach params to context variables
                            const advData = node.data as {
                                cfgScale?: unknown;
                                clipSkip?: unknown;
                                sampler?: unknown;
                                scheduler?: unknown;
                                seed?: unknown;
                                steps?: unknown;
                                useRandomSeed?: unknown;
                            };
                            const advInput = getLastOutput(executionContext);

                            if (advData.cfgScale !== undefined) {
                                executionContext.variables["cfg_scale"] = String(advData.cfgScale);
                            }

                            if (advData.sampler) {
                                executionContext.variables["sampler"] = String(advData.sampler);
                            }

                            if (advData.scheduler) {
                                executionContext.variables["scheduler"] = String(advData.scheduler);
                            }

                            if (advData.steps !== undefined) {
                                executionContext.variables["steps"] = String(advData.steps);
                            }

                            if (advData.clipSkip !== undefined) {
                                executionContext.variables["clip_skip"] = String(advData.clipSkip);
                            }

                            executionContext.variables["seed"] = String(
                                advData.useRandomSeed || advData.seed === undefined ? Math.floor(Math.random() * 2_147_483_647) : advData.seed,
                            );
                            output = advInput;
                            break;
                        }

                        case "ai": {
                            const result = await executeAINodeStreaming(node, executionContext, userProviderKeys ?? undefined, sendEvent, nodeId);

                            output = result.output;
                            usage = result.usage;
                            break;
                        }

                        case "audio": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeAudioNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "background-removal": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeBackgroundRemovalNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "branch": {
                            const result = executeBranchNode(node, executionContext);

                            output = result.output;
                            break;
                        }

                        case "character-ref": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeCharacterRefNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "code": {
                            const result = await executeCodeNode(node, executionContext);

                            if (!result.success) {
                                throw new Error(result.error);
                            }

                            output = result.output;
                            break;
                        }

                        case "controlnet": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeControlNetNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "file": {
                            const result = executeFileNode(node);

                            if (!result.success) {
                                throw new Error(result.error);
                            }

                            output = result.output;
                            break;
                        }

                        case "image": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeImageNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "image-to-video":
                        case "video": {
                            const result = await executeVideoNodeStreaming(node, executionContext, context, userId);

                            output = result.output;
                            break;
                        }

                        case "img2img": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeImg2ImgNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "inpaint": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeInpaintNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "object-editor": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeObjectEditorNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "outpaint": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeOutpaintNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "output": {
                            const result = executeOutputNode(node, executionContext);

                            output = result.output;
                            break;
                        }

                        case "parallel-compare": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeParallelCompareNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "style-ref": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeStyleRefNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "text": {
                            const result = executeTextNode(node, executionContext);

                            output = result.output;
                            break;
                        }

                        case "transcription": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeTranscriptionNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        case "upscale": {
                            const result = await withMediaCharge(
                                context,
                                executionContext,
                                node,
                                userId,
                                async (charge) => await executeUpscaleNodeStreaming(node, executionContext, context, userId, charge),
                            );

                            output = result.output;
                            break;
                        }

                        default: {
                            throw new Error(`Unknown node type: ${node.type}`);
                        }
                    }

                    storeOutput(executionContext, nodeId, output, node.data.label as string);
                    accumulateUsage(totalUsage, usage);

                    await context.runMutation(internal.agent.node_executions.update, {
                        completedAt: Date.now(),
                        nodeExecutionId: nodeExecution._id,
                        output,
                        status: "completed",
                        usage,
                    });

                    await sendEvent({ nodeId, output, type: "node_complete", usage });
                } catch (nodeError) {
                    const errorMessage = nodeError instanceof Error ? nodeError.message : "Unknown error";

                    await context.runMutation(internal.agent.node_executions.update, {
                        completedAt: Date.now(),
                        error: errorMessage,
                        nodeExecutionId: nodeExecution._id,
                        status: "failed",
                    });

                    await sendEvent({ error: errorMessage, nodeId, type: "node_error" });
                    throw nodeError;
                }
            }

            await context.runMutation(internal.agent.workflow_executions.updateStatus, {
                completedAt: Date.now(),
                executionId,
                status: "completed",
                totalUsage,
            });

            const outputNodes = workflowContent.nodes.filter((n) => n.type === "output");
            const outputs: Record<string, unknown> = {};

            for (const outputNode of outputNodes) {
                outputs[outputNode.id] = executionContext.nodeOutputs[outputNode.id];
            }

            await sendEvent({ output: outputs, type: "complete", usage: totalUsage });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Workflow execution failed";

            await context.runMutation(internal.agent.workflow_executions.updateStatus, {
                completedAt: Date.now(),
                error: errorMessage,
                executionId,
                status: "failed",
            });

            await sendEvent({ error: errorMessage, type: "error" });
        } finally {
            await writer.close();
        }
    };

    void executeWorkflow();

    return new Response(readable, {
        headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
        },
    });
};

// ============================================================================
// Streaming Node Executors
// ============================================================================

/**
 * Execute AI node with text streaming.
 */
const executeAINodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    userProviderKeys: Record<string, string> | undefined,
    sendEvent: (event: StreamEvent) => Promise<void>,
    nodeId: string,
): Promise<{ output: string; usage?: TokenUsage }> => {
    const data = node.data as {
        maxTokens?: number;
        model?: string;
        systemPrompt?: string;
        temperature?: number;
    };

    const prompt = getLastOutputAsString(context);
    const modelId = (data.model ?? "claude-sonnet-4-20250514") as string;

    const agents = await getAgents();
    const agent = agents[modelId] ?? agents["claude-sonnet-4-20250514" as string];
    let languageModel = agent?.chat;

    if (userProviderKeys && Object.keys(userProviderKeys).length > 0) {
        const { buildDynamicAgent } = await import("@neore/ai/providers");
        const dynamicConfig = await buildDynamicAgent(modelId, userProviderKeys);

        if (dynamicConfig?.chat) {
            languageModel = dynamicConfig.chat as typeof languageModel;
        }
    }

    if (!languageModel) {
        throw new Error(`Model ${modelId} not available`);
    }

    let fullText = "";
    const streamResult = streamTextAi({
        maxOutputTokens: data.maxTokens,
        model: languageModel,
        prompt,
        system: systemPromptFor(node, context),
        temperature: data.temperature,
    });

    for await (const chunk of streamResult.textStream) {
        fullText += chunk;
        await sendEvent({ nodeId, text: chunk, type: "text_chunk" });
    }

    const finalResult = await streamResult;
    const resolvedUsage = await finalResult.usage;
    const usage = resolvedUsage
        ? {
              completionTokens: resolvedUsage.outputTokens ?? 0,
              promptTokens: resolvedUsage.inputTokens ?? 0,
              totalTokens: (resolvedUsage.inputTokens ?? 0) + (resolvedUsage.outputTokens ?? 0),
          }
        : undefined;

    return { output: fullText, usage };
};

/**
 * Execute image node (non-streaming, but consistent interface).
 */
const executeImageNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        aspectRatio?: string;
        imageUrl?: string;
        mode?: string;
        model?: string;
        prompt?: string;
    };

    if (data.mode === "input") {
        return { output: data.imageUrl ?? "" };
    }

    const { prompt, referenceImages } = imageRequestArgs(node, context);

    if (!prompt) {
        throw new Error("No prompt provided for image generation");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateImage, {
        imageSize: data.aspectRatio ?? "1:1",
        model: resolveWorkflowModel("image", data.model),
        numImages: 1,
        prompt,
        threadId: "workflow",
        userId,
        ...(referenceImages.length > 0 && { referenceImages }),
    });

    return { output: result };
};

/**
 * Execute a video node, text-to-video or image-to-video (`runVideoNode`). A failure throws, as the other
 * streaming node executors do; the caller reports it as the node's error.
 */
const executeVideoNodeStreaming = async (node: WorkflowNode, context: ExecutionContext, actionContext: VideoRunContext, userId: string) =>
    await runVideoNode(node, context, actionContext, userId);

/**
 * Execute audio node (non-streaming).
 */
const executeAudioNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        model?: string;
        text?: string;
        voice?: string;
    };

    const inputValue = getLastOutput(context);
    const text = data.text ?? (typeof inputValue === "string" ? inputValue : "");

    if (!text) {
        throw new Error("No text provided for audio generation");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateAudio, {
        model: resolveWorkflowModel("tts", data.model),
        prompt: text,
        threadId: "workflow",
        userId,
        voice: data.voice,
    });

    return { output: result };
};

/**
 * Execute image-to-image node (non-streaming).
 */
const executeImg2ImgNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        model?: string;
        negativePrompt?: string;
        prompt?: string;
        strength?: number;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for image-to-image");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateImg2Img, {
        imageUrl,
        model: resolveWorkflowModel("img2img", data.model),
        negativePrompt: data.negativePrompt,
        prompt: data.prompt,
        strength: data.strength ?? 0.75,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute upscale node (non-streaming).
 */
const executeUpscaleNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        enhanceDetails?: boolean;
        enhanceFace?: boolean;
        model?: string;
        scale?: number;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for upscale");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateUpscale, {
        enhanceDetails: data.enhanceDetails ?? true,
        enhanceFace: data.enhanceFace ?? false,
        imageUrl,
        model: resolveWorkflowModel("upscale", data.model),
        scale: data.scale ?? 2,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute inpaint node (non-streaming).
 */
const executeInpaintNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        maskUrl?: string;
        model?: string;
        negativePrompt?: string;
        prompt: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for inpaint");
    }

    // Mask can come from node data or from a previous node
    let { maskUrl } = data;

    if (!maskUrl && typeof inputValue === "object" && inputValue !== null) {
        maskUrl = (inputValue as { maskUrl?: string }).maskUrl as string;
    }

    if (!maskUrl) {
        throw new Error("No mask provided for inpaint");
    }

    if (!data.prompt) {
        throw new Error("No prompt provided for inpaint");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateInpaint, {
        imageUrl,
        maskUrl,
        model: resolveWorkflowModel("inpaint", data.model),
        negativePrompt: data.negativePrompt,
        prompt: data.prompt,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute character reference node (non-streaming).
 */
const executeCharacterRefNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        mode?: "face" | "style" | "composition";
        model?: string;
        negativePrompt?: string;
        prompt?: string;
        referenceImages?: string[];
        strength?: number;
    };

    // Get reference images from node data or from previous node output
    let referenceImages = data.referenceImages ?? [];
    const inputValue = getLastOutput(context);

    // If no reference images in node, try to extract from input
    if (referenceImages.length === 0) {
        const inputUrl = extractUrl(inputValue, "imageUrl");

        if (inputUrl) {
            referenceImages = [inputUrl];
        }
    }

    if (referenceImages.length === 0) {
        throw new Error("No reference images provided");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateCharacterRef, {
        mode: data.mode ?? "face",
        model: data.model,
        negativePrompt: data.negativePrompt,
        prompt: data.prompt,
        referenceImages,
        strength: data.strength ?? 0.8,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute style reference node (non-streaming).
 */
const executeStyleRefNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        contentImageUrl?: string;
        model?: string;
        negativePrompt?: string;
        preserveContent?: boolean;
        prompt?: string;
        strength?: number;
        styleImageUrl?: string;
    };

    // Get style image from node data or from previous node output
    let { styleImageUrl } = data;
    const inputValue = getLastOutput(context);

    // If no style image in node, try to extract from input
    if (!styleImageUrl) {
        styleImageUrl = extractUrl(inputValue, "imageUrl");
    }

    if (!styleImageUrl) {
        throw new Error("No style image provided");
    }

    // Content image is optional - can come from node data or input
    let { contentImageUrl } = data;

    if (!contentImageUrl && typeof inputValue === "object" && inputValue !== null) {
        contentImageUrl = (inputValue as { contentImageUrl?: string }).contentImageUrl;
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateStyleRef, {
        contentImageUrl,
        model: data.model,
        negativePrompt: data.negativePrompt,
        preserveContent: data.preserveContent ?? true,
        prompt: data.prompt,
        strength: data.strength ?? 0.8,
        styleImageUrl,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute parallel compare node (non-streaming).
 */
const executeParallelCompareNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        aspectRatio?: string;
        models?: string[];
        negativePrompt?: string;
        prompt?: string;
    };

    // Get prompt from node data or from previous node output
    const inputValue = getLastOutput(context);
    const prompt = data.prompt ?? (typeof inputValue === "string" ? inputValue : "");

    if (!prompt) {
        throw new Error("No prompt provided for parallel comparison");
    }

    const models = data.models ?? [];

    if (models.length < 2) {
        throw new Error("At least 2 models required for comparison");
    }

    await charge(models.length);
    const result = await actionContext.runAction(internal.chat.functions.generateParallelCompare, {
        aspectRatio: data.aspectRatio,
        models,
        negativePrompt: data.negativePrompt,
        prompt,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute outpaint node (non-streaming).
 */
const executeOutpaintNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        expandDirection?: string;
        expandPixels?: number;
        model?: string;
        negativePrompt?: string;
        prompt?: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for outpaint");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateOutpaint, {
        expandDirection: data.expandDirection ?? "all",
        expandPixels: data.expandPixels,
        imageUrl,
        model: data.model,
        negativePrompt: data.negativePrompt,
        prompt: data.prompt,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute background removal node (non-streaming).
 */
const executeBackgroundRemovalNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        backgroundColor?: string;
        model?: string;
        outputFormat?: string;
        refineMask?: boolean;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for background removal");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateBackgroundRemoval, {
        backgroundColor: data.backgroundColor,
        imageUrl,
        model: data.model,
        outputFormat: data.outputFormat,
        refineMask: data.refineMask,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute object editor node (non-streaming).
 */
const executeObjectEditorNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        maskUrl?: string;
        mode: string;
        model?: string;
        negativePrompt?: string;
        prompt?: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for object editing");
    }

    let { maskUrl } = data;

    if (!maskUrl && typeof inputValue === "object" && inputValue !== null) {
        maskUrl = (inputValue as { maskUrl?: string }).maskUrl as string;
    }

    if (!maskUrl) {
        throw new Error("No mask provided for object editing");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateObjectEdit, {
        imageUrl,
        maskUrl,
        mode: data.mode ?? "remove",
        model: resolveWorkflowModel(data.mode === "add" ? "inpaint" : "objectRemove", data.model),
        negativePrompt: data.negativePrompt,
        prompt: data.prompt,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute ControlNet node (non-streaming).
 */
const executeControlNetNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        controlType: string;
        endPercent?: number;
        model?: string;
        preprocessor?: string;
        referenceImageUrl?: string;
        startPercent?: number;
        strength?: number;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = data.referenceImageUrl ?? extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        throw new Error("No image input provided for ControlNet");
    }

    const prompt = typeof inputValue === "string" ? inputValue : undefined;

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateControlNet, {
        controlType: data.controlType ?? "pose",
        endPercent: data.endPercent,
        imageUrl,
        model: resolveWorkflowModel("controlnet", data.model),
        preprocessor: data.preprocessor,
        prompt,
        startPercent: data.startPercent,
        strength: data.strength,
        threadId: "workflow",
        userId,
    });

    return { output: result };
};

/**
 * Execute transcription node (non-streaming).
 */
const executeTranscriptionNodeStreaming = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: HttpActionCtx,
    userId: string,
    charge: MediaCharge,
): Promise<{ output: unknown }> => {
    const data = node.data as {
        language?: string;
        model?: string;
    };

    const inputValue = getLastOutput(context);
    const audioUrl = extractUrl(inputValue, "audioUrl");

    if (!audioUrl) {
        throw new Error("No audio URL found in input");
    }

    await charge(1);
    const result = await actionContext.runAction(internal.chat.functions.generateTranscription, {
        audioUrl,
        language: data.language,
        model: resolveWorkflowModel("transcription", data.model),
        threadId: "workflow",
        userId,
    });

    return { output: result.text };
};

export default streamWorkflowHttpAction;
