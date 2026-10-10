import type { AgentConfig } from "@neore/ai/providers";

/**
 * Workflow Executor
 *
 * Executes workflow nodes in topological order, passing data between nodes
 * via a shared execution context.
 */
import { generateText, type LanguageModel } from "ai";
import { LunoraError, v } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx as ActionContext } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import {
    accumulateUsage,
    createEmptyUsage,
    executeBranchNode,
    executeCodeNode,
    executeFileNode,
    executeOutputNode,
    executeTextNode,
    type ExecutionContext,
    extractUrl,
    getExecutionOrder,
    getLastOutput,
    getLastOutputAsString,
    getNodeInput,
    type NodeExecutionResult,
    storeOutput,
    type WorkflowContent,
    type WorkflowNode,
} from "./core";
import { MAX_LENGTH } from "../lib/validators";

// ============================================================================
// AI Node Executor
// ============================================================================

let _agentsPromise: Promise<Record<string, AgentConfig>> | undefined;

const getAgents = (): Promise<Record<string, AgentConfig>> => {
    if (!_agentsPromise) {
        _agentsPromise = import("@neore/ai/providers").then(({ buildAgents }) => buildAgents());
    }

    return _agentsPromise;
};

/**
 * Execute an AI node using the agent system.
 */
const executeAINode = async (node: WorkflowNode, context: ExecutionContext, userProviderKeys?: Record<string, string>): Promise<NodeExecutionResult> => {
    const data = node.data as {
        maxTokens?: number;
        model?: string;
        systemPrompt?: string;
        temperature?: number;
    };

    const prompt = getLastOutputAsString(context);

    if (!prompt) {
        return { error: "No input provided to AI node", success: false };
    }

    const modelId = (data.model ?? "claude-sonnet-4-20250514") as string;

    try {
        const agents = await getAgents();
        let agent = agents[modelId];

        if (!agent) {
            agent = agents["claude-sonnet-4-20250514" as string];

            if (!agent) {
                return { error: `Unknown model: ${modelId}`, success: false };
            }
        }

        let languageModel = agent.chat;

        if (!languageModel) {
            return { error: `Model ${modelId} is not a text model`, success: false };
        }

        // BYOK support
        if (userProviderKeys) {
            const { buildDynamicAgent } = await import("@neore/ai/providers");
            const dynamicConfig = await buildDynamicAgent(modelId, userProviderKeys);

            if (dynamicConfig?.chat) {
                languageModel = dynamicConfig.chat as LanguageModel;
            }
        }

        const result = await generateText({
            maxOutputTokens: data.maxTokens,
            model: languageModel,
            prompt,
            system: data.systemPrompt,
            temperature: data.temperature,
        });

        return {
            output: result.text,
            success: true,
            usage: result.usage
                ? {
                      completionTokens: result.usage.outputTokens ?? 0,
                      promptTokens: result.usage.inputTokens ?? 0,
                      totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
                  }
                : undefined,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "AI execution failed",
            success: false,
        };
    }
};

// ============================================================================
// Media Node Executors (require ActionContext)
// ============================================================================

/**
 * Image node: either passes through a URL the user supplied (`mode: "input"`) or
 * generates one from a prompt.
 *
 * The prompt is taken from the upstream node's output when there is one, so a
 * text node feeding an image node works without wiring it explicitly; the node's
 * own `prompt` is the fallback.
 */
const executeImageNode = async (node: WorkflowNode, context: ExecutionContext, actionContext: ActionContext, userId: string): Promise<NodeExecutionResult> => {
    const data = node.data as {
        aspectRatio?: string;
        imageUrl?: string;
        mode: "input" | "generate";
        model?: string;
        numImages?: number;
        prompt?: string;
    };

    if (data.mode === "input") {
        return { output: data.imageUrl ?? "", success: true };
    }

    const inputPrompt = getLastOutput(context);
    const prompt = typeof inputPrompt === "string" ? inputPrompt : data.prompt;

    if (!prompt) {
        return { error: "No prompt provided for image generation", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateImage, {
            imageSize: data.aspectRatio ?? "1:1",
            model: data.model ?? "fal:flux-dev",
            numImages: data.numImages ?? 1,
            prompt,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Image generation failed",
            success: false,
        };
    }
};

/**
 * Execute an image-to-image node.
 */
const executeImg2ImgNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        model?: string;
        negativePrompt?: string;
        prompt?: string;
        strength?: number;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for image-to-image", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateImg2Img, {
            imageUrl,
            model: data.model,
            negativePrompt: data.negativePrompt,
            prompt: data.prompt,
            strength: data.strength ?? 0.75,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Image-to-image transformation failed",
            success: false,
        };
    }
};

/** Upscale node: enlarges the upstream image and returns the new URL. */
const executeUpscaleNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        enhanceDetails?: boolean;
        enhanceFace?: boolean;
        model?: string;
        scale?: number;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for upscale", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateUpscale, {
            enhanceDetails: data.enhanceDetails ?? true,
            enhanceFace: data.enhanceFace ?? false,
            imageUrl,
            model: data.model,
            scale: data.scale ?? 2,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Image upscale failed",
            success: false,
        };
    }
};

/** Inpaint node: repaints the masked region of the upstream image from a prompt. */
const executeInpaintNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        maskUrl?: string;
        model?: string;
        negativePrompt?: string;
        prompt: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for inpaint", success: false };
    }

    // Mask can come from node data or from a previous node
    let { maskUrl } = data;

    if (!maskUrl && typeof inputValue === "object" && inputValue !== null) {
        maskUrl = (inputValue as { maskUrl?: string }).maskUrl as string;
    }

    if (!maskUrl) {
        return { error: "No mask provided for inpaint", success: false };
    }

    if (!data.prompt) {
        return { error: "No prompt provided for inpaint", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateInpaint, {
            imageUrl,
            maskUrl,
            model: data.model,
            negativePrompt: data.negativePrompt,
            prompt: data.prompt,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Image inpaint failed",
            success: false,
        };
    }
};

/**
 * Execute a character reference node (IP-Adapter).
 */
const executeCharacterRefNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
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
        return { error: "No reference images provided", success: false };
    }

    try {
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

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Character reference generation failed",
            success: false,
        };
    }
};

/**
 * Execute a style reference node.
 */
const executeStyleRefNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
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
        return { error: "No style image provided", success: false };
    }

    // Content image is optional - can come from node data or input
    let { contentImageUrl } = data;

    if (!contentImageUrl && typeof inputValue === "object" && inputValue !== null) {
        contentImageUrl = (inputValue as { contentImageUrl?: string }).contentImageUrl;
    }

    try {
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

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Style reference generation failed",
            success: false,
        };
    }
};

/**
 * Execute a parallel compare node - run same prompt through multiple models.
 */
const executeParallelCompareNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
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
        return { error: "No prompt provided for parallel comparison", success: false };
    }

    const models = data.models ?? [];

    if (models.length < 2) {
        return { error: "At least 2 models required for comparison", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateParallelCompare, {
            aspectRatio: data.aspectRatio,
            models,
            negativePrompt: data.negativePrompt,
            prompt,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Parallel comparison failed",
            success: false,
        };
    }
};

/**
 * Execute a video node.
 */
const executeVideoNode = async (node: WorkflowNode, context: ExecutionContext, actionContext: ActionContext, userId: string): Promise<NodeExecutionResult> => {
    const data = node.data as {
        aspectRatio?: string;
        duration?: number;
        fps?: number;
        mode?: "text-to-video" | "image-to-video";
        model?: string;
        motionStrength?: number;
        prompt?: string;
    };

    const inputValue = getLastOutput(context);

    // If mode is image-to-video, dispatch to the image-to-video action
    if (data.mode === "image-to-video") {
        const imageUrl = extractUrl(inputValue, "imageUrl");

        if (!imageUrl) {
            return { error: "No image input provided for image-to-video mode", success: false };
        }

        try {
            const result = await actionContext.runAction(internal.chat.functions.generateImageToVideo, {
                duration: data.duration,
                fps: data.fps,
                imageUrl,
                model: data.model,
                motionStrength: data.motionStrength,
                prompt: data.prompt,
                threadId: "workflow",
                userId,
            });

            return { output: result, success: true };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Image-to-video generation failed",
                success: false,
            };
        }
    }

    // Default: text-to-video mode
    const prompt = data.prompt ?? (typeof inputValue === "string" ? inputValue : "");

    if (!prompt) {
        return { error: "No prompt provided for video generation", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateVideo, {
            aspectRatio: data.aspectRatio ?? "16:9",
            duration: data.duration ?? 5,
            model: data.model ?? "fal:mochi-v1",
            prompt,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Video generation failed",
            success: false,
        };
    }
};

/**
 * Execute an audio node (text-to-speech).
 */
const executeAudioNode = async (node: WorkflowNode, context: ExecutionContext, actionContext: ActionContext, userId: string): Promise<NodeExecutionResult> => {
    const data = node.data as {
        model?: string;
        text?: string;
        voice?: string;
    };

    const inputValue = getLastOutput(context);
    const text = data.text ?? (typeof inputValue === "string" ? inputValue : "");

    if (!text) {
        return { error: "No text provided for audio generation", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateAudio, {
            model: data.model ?? "openai:tts-1",
            prompt: text,
            threadId: "workflow",
            userId,
            voice: data.voice,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Audio generation failed",
            success: false,
        };
    }
};

/**
 * Execute a transcription node (speech-to-text).
 */
const executeTranscriptionNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        language?: string;
        model?: string;
    };

    const inputValue = getLastOutput(context);

    if (!inputValue) {
        return { error: "No audio input provided for transcription", success: false };
    }

    const audioUrl = extractUrl(inputValue, "audioUrl");

    if (!audioUrl) {
        return { error: "No audio URL found in input", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateTranscription, {
            audioUrl,
            language: data.language,
            model: data.model,
            threadId: "workflow",
            userId,
        });

        return { output: result.text, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Transcription failed",
            success: false,
        };
    }
};

/**
 * Execute an outpaint node - expand image canvas.
 */
const executeOutpaintNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        expandDirection: string;
        expandPixels?: number;
        model?: string;
        negativePrompt?: string;
        prompt?: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for outpaint", success: false };
    }

    try {
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

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Outpaint failed",
            success: false,
        };
    }
};

/**
 * Execute a background removal node.
 */
const executeBackgroundRemovalNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        backgroundColor?: string;
        model?: string;
        outputFormat?: string;
        refineMask?: boolean;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for background removal", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateBackgroundRemoval, {
            backgroundColor: data.backgroundColor,
            imageUrl,
            model: data.model,
            outputFormat: data.outputFormat,
            refineMask: data.refineMask,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Background removal failed",
            success: false,
        };
    }
};

/**
 * Execute an object editor node - remove or add objects.
 */
const executeObjectEditorNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        maskUrl?: string;
        mode: "remove" | "add";
        model?: string;
        negativePrompt?: string;
        prompt?: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for object editing", success: false };
    }

    let { maskUrl } = data;

    if (!maskUrl && typeof inputValue === "object" && inputValue !== null) {
        maskUrl = (inputValue as { maskUrl?: string }).maskUrl as string;
    }

    if (!maskUrl) {
        return { error: "No mask provided for object editing", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateObjectEdit, {
            imageUrl,
            maskUrl,
            mode: data.mode ?? "remove",
            model: data.model,
            negativePrompt: data.negativePrompt,
            prompt: data.prompt,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Object editing failed",
            success: false,
        };
    }
};

/** Image-to-video node: animates the upstream image and returns the video URL. */
const executeImageToVideoNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        duration?: number;
        fps?: number;
        loop?: boolean;
        model?: string;
        motionStrength?: number;
        prompt?: string;
    };

    const inputValue = getLastOutput(context);
    const imageUrl = extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for image-to-video", success: false };
    }

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateImageToVideo, {
            duration: data.duration,
            fps: data.fps,
            imageUrl,
            loop: data.loop,
            model: data.model,
            motionStrength: data.motionStrength,
            prompt: data.prompt,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Image-to-video generation failed",
            success: false,
        };
    }
};

/**
 * Execute a ControlNet node - guided image generation.
 */
const executeControlNetNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: ActionContext,
    userId: string,
): Promise<NodeExecutionResult> => {
    const data = node.data as {
        controlType: string;
        endPercent?: number;
        model?: string;
        preprocessor?: string;
        referenceImageUrl?: string;
        startPercent?: number;
        strength?: number;
    };

    // Get the control image from input or node data
    const inputValue = getLastOutput(context);
    const imageUrl = data.referenceImageUrl ?? extractUrl(inputValue, "imageUrl");

    if (!imageUrl) {
        return { error: "No image input provided for ControlNet", success: false };
    }

    // ControlNet also needs a prompt - get from the input text or a connected text node
    const prompt = typeof inputValue === "string" ? inputValue : undefined;

    try {
        const result = await actionContext.runAction(internal.chat.functions.generateControlNet, {
            controlType: data.controlType ?? "pose",
            endPercent: data.endPercent,
            imageUrl,
            model: data.model,
            preprocessor: data.preprocessor,
            prompt,
            startPercent: data.startPercent,
            strength: data.strength,
            threadId: "workflow",
            userId,
        });

        return { output: result, success: true };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "ControlNet generation failed",
            success: false,
        };
    }
};

/**
 * Execute an advanced controls node - pass-through modifier that
 * attaches generation parameters to the execution context.
 */
const executeAdvancedControlsNode = (node: WorkflowNode, context: ExecutionContext): NodeExecutionResult => {
    const data = node.data as {
        cfgScale?: number;
        clipSkip?: number;
        sampler?: string;
        scheduler?: string;
        seed?: number;
        steps?: number;
        useRandomSeed?: boolean;
    };

    // Pass through the input while attaching advanced params to context
    const input = getLastOutput(context);

    // Store the advanced controls in the context variables so downstream
    // nodes can read them
    if (data.cfgScale !== undefined) {
        context.variables["cfg_scale"] = String(data.cfgScale);
    }

    if (data.sampler) {
        context.variables["sampler"] = data.sampler;
    }

    if (data.scheduler) {
        context.variables["scheduler"] = data.scheduler;
    }

    if (data.steps !== undefined) {
        context.variables["steps"] = String(data.steps);
    }

    if (data.clipSkip !== undefined) {
        context.variables["clip_skip"] = String(data.clipSkip);
    }

    context.variables["seed"] = String(data.useRandomSeed || data.seed === undefined ? Math.floor(Math.random() * 2_147_483_647) : data.seed);

    return { output: input, success: true };
};

// ============================================================================
// Main Executor Action
// ============================================================================

/**
 * Execute a workflow
 */
// Output declared and handler annotated so codegen prints a SELF-CONTAINED type.
// Left to inference it emitted `import("./core").TokenUsage` into
// `_generated/api.ts` — a specifier resolved against this file's directory, which
// means nothing from `_generated/`.
export const executeWorkflow = authAction
    .use(rateLimit("workflow/execute"))
    .input({
        projectId: v.id("projects"),
        variables: v.optional(v.record(v.string().max(MAX_LENGTH.document), v.string().max(MAX_LENGTH.document))),
    })
    .output(
        v.object({
            error: v.optional(v.string()),
            executionId: v.string(),
            outputs: v.optional(v.record(v.string(), v.any())),
            status: v.union(v.literal("completed"), v.literal("failed")),
            usage: v.optional(v.object({ completionTokens: v.number(), promptTokens: v.number(), totalTokens: v.number() })),
        }),
    )
    .action(async ({ args: input, ctx: context }) => {
        const { projectId, variables } = input;
        const { userId } = context.user;

        const project = await context.runQuery(api.workflow.functions.getWorkflow, { projectId });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Workflow not found");
        }

        const workflowContent = project.workflowContent as WorkflowContent | undefined;

        if (!workflowContent || workflowContent.nodes.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Workflow has no nodes");
        }

        const userProviderKeys = await context.runQuery(internal.auth.functions.getDecryptedProviderKeysQuery, { userId });

        const execution = await context.runMutation(internal.agent.workflow_executions.create, {
            projectId: projectId as Id<"projects">,
            status: "running",
            userId,
            workflowSnapshot: workflowContent,
        });

        const executionId = execution._id;

        try {
            await context.runMutation(internal.agent.workflow_executions.updateStatus, {
                executionId,
                startedAt: Date.now(),
                status: "running",
            });

            const executionContext: ExecutionContext = {
                data: {},
                nodeOutputs: {},
                variables: variables ?? {},
            };

            const executionOrder = getExecutionOrder(workflowContent.nodes, workflowContent.edges);
            const totalUsage = createEmptyUsage();

            for (const nodeId of executionOrder) {
                const node = workflowContent.nodes.find((n) => n.id === nodeId);

                if (!node) {
                    continue;
                }

                const nodeExecution = await context.runMutation(internal.agent.node_executions.create, {
                    executionId,
                    input: getNodeInput(nodeId, workflowContent.edges, executionContext),
                    nodeId,
                    nodeType: node.type,
                    startedAt: Date.now(),
                    status: "running",
                });

                try {
                    let result: NodeExecutionResult;

                    switch (node.type) {
                        case "advanced-controls": {
                            result = executeAdvancedControlsNode(node, executionContext);
                            break;
                        }
                        case "ai": {
                            result = await executeAINode(node, executionContext, userProviderKeys ?? undefined);
                            break;
                        }
                        case "audio": {
                            result = await executeAudioNode(node, executionContext, context, userId);
                            break;
                        }
                        case "background-removal": {
                            result = await executeBackgroundRemovalNode(node, executionContext, context, userId);
                            break;
                        }
                        case "branch": {
                            result = executeBranchNode(node, executionContext);
                            break;
                        }
                        case "character-ref": {
                            result = await executeCharacterRefNode(node, executionContext, context, userId);
                            break;
                        }
                        case "code": {
                            result = await executeCodeNode(node, executionContext);
                            break;
                        }
                        case "controlnet": {
                            result = await executeControlNetNode(node, executionContext, context, userId);
                            break;
                        }
                        case "file": {
                            result = executeFileNode(node);
                            break;
                        }
                        case "image": {
                            result = await executeImageNode(node, executionContext, context, userId);
                            break;
                        }
                        case "image-to-video": {
                            result = await executeImageToVideoNode(node, executionContext, context, userId);
                            break;
                        }
                        case "img2img": {
                            result = await executeImg2ImgNode(node, executionContext, context, userId);
                            break;
                        }
                        case "inpaint": {
                            result = await executeInpaintNode(node, executionContext, context, userId);
                            break;
                        }
                        case "object-editor": {
                            result = await executeObjectEditorNode(node, executionContext, context, userId);
                            break;
                        }
                        case "outpaint": {
                            result = await executeOutpaintNode(node, executionContext, context, userId);
                            break;
                        }
                        case "output": {
                            result = executeOutputNode(node, executionContext);
                            break;
                        }
                        case "parallel-compare": {
                            result = await executeParallelCompareNode(node, executionContext, context, userId);
                            break;
                        }
                        case "style-ref": {
                            result = await executeStyleRefNode(node, executionContext, context, userId);
                            break;
                        }
                        case "text": {
                            result = executeTextNode(node, executionContext);
                            break;
                        }
                        case "transcription": {
                            result = await executeTranscriptionNode(node, executionContext, context, userId);
                            break;
                        }
                        case "upscale": {
                            result = await executeUpscaleNode(node, executionContext, context, userId);
                            break;
                        }
                        case "video": {
                            result = await executeVideoNode(node, executionContext, context, userId);
                            break;
                        }
                        default: {
                            result = { error: `Unknown node type: ${node.type}`, success: false };
                        }
                    }

                    if (result.success && result.output !== undefined) {
                        storeOutput(executionContext, nodeId, result.output, node.data.label as string);
                    }

                    accumulateUsage(totalUsage, result.usage);

                    await context.runMutation(internal.agent.node_executions.update, {
                        completedAt: Date.now(),
                        error: result.error,
                        nodeExecutionId: nodeExecution._id,
                        output: result.output,
                        status: result.success ? "completed" : "failed",
                        usage: result.usage,
                    });

                    if (!result.success) {
                        throw new LunoraError("INTERNAL", result.error ?? "Node execution failed");
                    }
                } catch (nodeError) {
                    await context.runMutation(internal.agent.node_executions.update, {
                        completedAt: Date.now(),
                        error: nodeError instanceof Error ? nodeError.message : "Unknown error",
                        nodeExecutionId: nodeExecution._id,
                        status: "failed",
                    });

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

            context.log.event("workflow.execute_workflow", { nodeCount: workflowContent.nodes.length, outputCount: outputNodes.length, status: "completed" });

            return {
                executionId,
                outputs,
                status: "completed" as const,
                usage: totalUsage,
            };
        } catch (error) {
            await context.runMutation(internal.agent.workflow_executions.updateStatus, {
                completedAt: Date.now(),
                error: error instanceof Error ? error.message : "Workflow execution failed",
                executionId,
                status: "failed",
            });

            context.log.event("workflow.execute_workflow", { status: "failed" });

            return {
                error: error instanceof Error ? error.message : "Workflow execution failed",
                executionId,
                status: "failed" as const,
            };
        }
    });
