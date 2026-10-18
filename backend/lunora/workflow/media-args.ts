/**
 * The arguments the workflow's action executor and streaming endpoint both send for a node: a
 * video node's provider-readable inputs, an image node's prompt and reference array, an AI node's
 * system prompt, and the one shape a video node stores. Both entry points read these, so the two
 * cannot disagree on what a node sends.
 */
import { falVideoInputsOf } from "@neore/ai/models";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { type ExecutionContext, getLastOutput, type WorkflowContent, type WorkflowNode } from "./core";
import { expandNodeMentions, referenceImageUrls } from "./mention-targets";
import { isFrameHandleId } from "./mentions";
import { runBilledVideo, type VideoRunCosts } from "./video-billing";
import {
    type FrameSource,
    frameSourceOf,
    generatedClipSecondsOf,
    isVideoNode,
    type MediaRef,
    mediaOf,
    modelIdFor,
    resolveMediaUrls,
    resolveVideoInputUrls,
    videoDefinitionOf,
    videoDurationOf,
    videoInputErrors,
    videoKindOf,
    wireRoleOf,
    wiredInputsOf,
} from "./video-inputs";
import { frameClipSeconds, frameExtractionMicrodollars, frameRequestId, videoRunCost } from "./video-policy";
import { readRunPlan } from "../chat/lib/agent-run";

/** The part of an action or HTTP action context the workflow reads stored files through, and extracts frames with. */
export interface WorkflowFileContext {
    runAction: (
        action: typeof internal.workflow.media_ops.extractVideoFrame,
        args: {
            charge?: { costMicrodollars: number; orgId: string; requestId: string };
            frame: "start" | "end";
            threadId: string;
            userId: string;
            videoUrl: string;
        },
    ) => Promise<{ fileId: string; mimeType: string }>;
    runQuery: (query: typeof api.file.getChatFileImageUrl, args: { fileId: Id<"chatFiles"> }) => Promise<string | null>;
}

/** A stored file's display URL for the workflow's owner; `null` when they hold no grant for it. */
const signChatFile = async (context: WorkflowFileContext, fileId: string): Promise<string | null> =>
    await context.runQuery(api.file.getChatFileImageUrl, { fileId: fileId as Id<"chatFiles"> });

/** The key a run memoizes a frame extraction under: one per source clip and kind. */
const frameKeyOf = (source: Pick<FrameSource, "kind" | "sourceId">): string => `${source.sourceId}:${source.kind}`;

/** What extracting a frame of this source clip costs, in microdollars: fal bills the clip's seconds. */
const extractionCostOf = (source: FrameSource, context: ExecutionContext): number =>
    frameExtractionMicrodollars(frameClipSeconds(context.graph.nodes.find((candidate) => candidate.id === source.sourceId)));

/**
 * The stored file of a frame wire, extracted from its source clip. A frame wired into two nodes is
 * extracted once per run: the promise is kept on the run's context, keyed by source and kind. The
 * extraction is charged where it is made, whether it succeeds or fails: fal bills the attempt, and the
 * charge is keyed on the source so the second reader of the frame pays nothing.
 */
const extractedFrameFileId = (context: ExecutionContext, files: WorkflowFileContext, userId: string, source: FrameSource, videoUrl: string) => {
    const frames = context.frames ?? new Map<string, Promise<string>>();

    context.frames = frames;

    const key = frameKeyOf(source);
    const known = frames.get(key);

    if (known) {
        return known;
    }

    // The extraction action charges it once fal accepts the request, so a run that never reaches fal bills nothing.
    const charge =
        context.orgId === undefined
            ? undefined
            : {
                  costMicrodollars: extractionCostOf(source, context),
                  orgId: context.orgId,
                  requestId: frameRequestId(context.runId, source.sourceId, source.kind),
              };
    const pending = files
        .runAction(internal.workflow.media_ops.extractVideoFrame, { charge, frame: source.kind, threadId: "workflow", userId, videoUrl })
        .then((stored) => stored.fileId);

    frames.set(key, pending);

    return pending;
};

/**
 * The frame extraction a node run would start, in microdollars, for the pre-check: `undefined` when no clip
 * is wired to its frame, or when the run has already extracted that frame (its node paid).
 */
const frameExtractionDue = (node: WorkflowNode, context: ExecutionContext): number | undefined => {
    const source = frameSourceOf(node, context);

    if (!source?.clip || context.frames?.has(frameKeyOf(source))) {
        return undefined;
    }

    return extractionCostOf(source, context);
};

/**
 * The seconds of reference video this node sends, for the reference charge. Each wired video is taken up to the
 * model's cap, in wire order. A generated clip counts its billed length; a clip of unknown length (an upload) makes
 * the sum the endpoint's whole reference budget, since a valid request cannot exceed that. 0 when none is sent.
 */
export const referenceSecondsOf = (node: WorkflowNode, context: ExecutionContext): number => {
    const model = videoDefinitionOf(node);
    const cap = model?.maxReferenceVideos ?? 0;
    const wired = context.graph.edges
        .filter((edge) => edge.target === node.id && !isFrameHandleId(edge.sourceHandle))
        .flatMap((edge) => context.graph.nodes.filter((candidate) => candidate.id === edge.source))
        .filter((source) => wireRoleOf(source) === "reference" && mediaOf(context.nodeOutputs[source.id])?.mimeType.startsWith("video/") === true)
        .slice(0, cap);

    if (wired.length === 0) {
        return 0;
    }

    if (wired.some((source) => !isVideoNode(source))) {
        return falVideoInputsOf(model?.modelApiId)?.references?.totalSeconds ?? 0;
    }

    return wired.reduce((seconds, source) => seconds + generatedClipSecondsOf(source), 0);
};

/** The frame a video node's wire carries, as a stored file. `undefined` when no frame is wired. */
const frameRefOf = async (
    node: WorkflowNode,
    context: ExecutionContext,
    files: WorkflowFileContext,
    userId: string,
    sign: (fileId: string) => Promise<string | null>,
): Promise<MediaRef | undefined> => {
    const source = frameSourceOf(node, context);

    if (!source) {
        return undefined;
    }

    if (!source.clip) {
        throw new Error(`The ${source.kind} frame needs a clip, and its source node produced none in this run`);
    }

    const [videoUrl] = await resolveMediaUrls([source.clip.ref], sign);

    if (videoUrl === undefined) {
        throw new Error(`The clip for the ${source.kind} frame could not be read`);
    }

    return { fileId: await extractedFrameFileId(context, files, userId, source, videoUrl) };
};

/**
 * A video node's provider-readable inputs. `frameUrl` is the wired frame alone: the caller decides
 * whether an upstream image may stand in for it, since text-to-video never used one.
 */
export const videoInputArgs = async (node: WorkflowNode, context: ExecutionContext, files: WorkflowFileContext, userId: string) => {
    const model = videoDefinitionOf(node);
    const sign = (fileId: string) => signChatFile(files, fileId);
    const frame = await frameRefOf(node, context, files, userId, sign);
    const inputs = await resolveVideoInputUrls(node, context, sign, model, frame);

    return {
        // The start image: a wired frame, or for image-to-video the wired image (`resolveVideoInputs`).
        frameUrl: inputs.image,
        prompt: wiredInputsOf(node, context).prompt,
        referenceAudioUrls: inputs.referenceAudioUrls,
        referenceVideoUrls: inputs.referenceVideoUrls,
    };
};

/**
 * A video node's prompt: its own stored prompt, else the text wired into it (`wiredInputsOf`). The one reading
 * both entry points use, so a run and a stream cannot disagree on what a node sends.
 */
export const videoPromptOf = (node: WorkflowNode, context: ExecutionContext): string => {
    const data = node.data as { prompt?: string };

    return data.prompt ?? wiredInputsOf(node, context).prompt ?? "";
};

/** The fields a video node's run reads: its generation settings, and the prompt and mode it stores. */
export interface VideoNodeRunData {
    aspectRatio?: string;
    duration?: number;
    fps?: number;
    generateAudio?: boolean;
    mode?: "text-to-video" | "image-to-video";
    model?: string;
    motionStrength?: number;
    prompt?: string;
    resolution?: string;
}

/** An image-to-video node's fields: the video fields, and whether the clip loops, which only that node has. */
export interface ImageToVideoNodeRunData extends VideoNodeRunData {
    loop?: boolean;
}

export type VideoInputArgs = Awaited<ReturnType<typeof videoInputArgs>>;

/** The provider inputs a video action takes; the wired prompt is optional, since a text-to-video run sends its own. */
type InputArgsWithPrompt = Omit<VideoInputArgs, "prompt"> & Partial<Pick<VideoInputArgs, "prompt">>;

/**
 * The arguments of the image-to-video action for a video node. The options are sent only when the
 * stored value has the type the action takes; the action keeps only the ones the model accepts
 * (`fal-video-inputs.ts`), so a value left over from an earlier model is dropped there. The duration is
 * the run's billed length (`videoDurationOf`), so the endpoint is sent the length the run pays for.
 */
export const imageToVideoArgs = (node: WorkflowNode, imageUrl: string, inputs: InputArgsWithPrompt, userId: string) => {
    const data = node.data as ImageToVideoNodeRunData;

    return {
        duration: videoDurationOf(node, videoDefinitionOf(node)).requested,
        fps: data.fps,
        generateAudio: typeof data.generateAudio === "boolean" ? data.generateAudio : undefined,
        imageUrl,
        // Only the image-to-video node type has a loop option; a video node's stored value never reaches the action.
        loop: node.type === "image-to-video" ? data.loop : undefined,
        model: modelIdFor(node, "imageToVideo"),
        motionStrength: data.motionStrength,
        prompt: data.prompt ?? inputs.prompt,
        referenceAudioUrls: inputs.referenceAudioUrls,
        referenceVideoUrls: inputs.referenceVideoUrls,
        resolution: typeof data.resolution === "string" ? data.resolution : undefined,
        threadId: "workflow",
        userId,
    };
};

/** The arguments of the text-to-video action for a video node, with the node's defaults for what it leaves unset. */
export const textToVideoArgs = (node: WorkflowNode, prompt: string, inputs: InputArgsWithPrompt, userId: string) => {
    const data = node.data as VideoNodeRunData;

    return {
        aspectRatio: data.aspectRatio ?? "16:9",
        duration: videoDurationOf(node, videoDefinitionOf(node)).requested,
        generateAudio: typeof data.generateAudio === "boolean" ? data.generateAudio : undefined,
        model: modelIdFor(node, "textToVideo"),
        prompt,
        referenceAudioUrls: inputs.referenceAudioUrls,
        referenceVideoUrls: inputs.referenceVideoUrls,
        resolution: typeof data.resolution === "string" ? data.resolution : undefined,
        startFrameUrl: inputs.frameUrl,
        threadId: "workflow",
        userId,
    };
};

/**
 * What a video node needs before it pays for anything: a prompt in text-to-video mode, a start image
 * (a frame wire, or an upstream image) in image-to-video mode. Checked before any frame is extracted,
 * so a node that cannot run never bills its extraction. Returns the error, or `undefined` to run.
 */
export const videoRunInputError = (node: WorkflowNode, context: ExecutionContext): string | undefined => {
    if (videoKindOf(node) === "imageToVideo") {
        const hasImage = frameSourceOf(node, context) !== undefined || wiredInputsOf(node, context).image !== undefined;

        return hasImage ? undefined : "No image input provided for image-to-video mode";
    }

    return videoPromptOf(node, context) ? undefined : "No prompt provided for video generation";
};

/**
 * An image node's prompt and reference images. An upstream text output is the prompt when there is
 * one, and its `@label` mentions of this node's reference images are numbered here too: the text
 * node cannot know this node's "image N", so the text is expanded for images only.
 */
export const imageRequestArgs = (node: WorkflowNode, context: ExecutionContext) => {
    const data = node.data as { prompt?: string };
    const inputPrompt = getLastOutput(context);
    const ownPrompt = data.prompt && expandNodeMentions(node, data.prompt, context);

    return {
        prompt: typeof inputPrompt === "string" ? expandNodeMentions(node, inputPrompt, context, ["image"]) : ownPrompt,
        referenceImages: referenceImageUrls(node, context),
    };
};

/** An AI node's system prompt, with its mentions expanded. */
export const systemPromptFor = (node: WorkflowNode, context: ExecutionContext) => {
    const data = node.data as { systemPrompt?: string };

    return data.systemPrompt && expandNodeMentions(node, data.systemPrompt, context, ["text"]);
};

/** What the video actions return: a text-to-video result already has `assets`, an image-to-video one is a single clip. */
export type VideoActionResult =
    | { assets: { fileId?: string; mimeType: string; videoUrl: string }[]; modelId: string; prompt: string }
    | { fileId: string; mimeType: string; model: string; videoUrl: string };

/**
 * The one shape a video node stores: `assets[0]` is the clip, with its stored file id when the
 * action returned one. A downstream node reads that clip the same way whichever action made it.
 */
export const videoNodeOutput = (result: VideoActionResult, prompt: string) => {
    if ("assets" in result) {
        return result;
    }

    return {
        assets: [{ fileId: result.fileId, mimeType: result.mimeType, videoUrl: result.videoUrl }],
        modelId: result.model,
        prompt,
    };
};

/** The input errors that need only the graph. Run before any node, so a doomed run bills nothing. */
export const workflowInputErrors = (content: Pick<WorkflowContent, "edges" | "nodes">): string[] => videoInputErrors(content.nodes, content.edges);

/** The context a video node runs through: the actions it calls, and the mutations that bill it. */
export type VideoRunContext = Pick<ActionCtx, "runAction" | "runMutation" | "runQuery">;

/**
 * One video node, end to end: the input check, then the billed run (`runBilledVideo`: credits and quota,
 * the frame extraction and the paid call, the charge). Both run paths call this and differ only in how
 * they report a failure, so a node cannot skip its charge or its checks. Throws the message the run reports.
 */
export const runVideoNode = async (
    node: WorkflowNode,
    context: ExecutionContext,
    actionContext: VideoRunContext,
    userId: string,
): Promise<{ output: ReturnType<typeof videoNodeOutput> }> => {
    // Before any frame is extracted, so a node that cannot run bills nothing.
    const inputError = videoRunInputError(node, context);

    if (inputError) {
        throw new Error(inputError);
    }

    const kind = videoKindOf(node);
    // The action's own plan read (`generateVideo` reads it the same way), so the clamp and the charge agree with the call.
    const plan = await readRunPlan(actionContext, userId, context.orgId ?? null);
    const costs: VideoRunCosts = {
        clipMicrodollars: videoRunCost(node, {
            // A start image is sent to image-to-video always, and to text-to-video when a frame is wired (`textToVideoArgs`).
            paidPlan: plan.isAdmin || plan.plan === "premium",
            referenceSeconds: referenceSecondsOf(node, context),
            startImage: kind === "imageToVideo" || frameSourceOf(node, context) !== undefined,
        }).costMicrodollars,
        extractionMicrodollars: frameExtractionDue(node, context),
    };

    const output = await runBilledVideo(actionContext, context, node, userId, costs, async () => {
        const inputs = await videoInputArgs(node, context, actionContext, userId);

        if (kind === "imageToVideo") {
            const imageUrl = inputs.frameUrl;

            if (!imageUrl) {
                throw new Error("No image input provided for image-to-video mode");
            }

            const result = await actionContext.runAction(internal.chat.functions.generateImageToVideo, {
                ...imageToVideoArgs(node, imageUrl, inputs, userId),
                organizationId: context.orgId ?? null,
            });

            return videoNodeOutput(result, (node.data as { prompt?: string }).prompt ?? inputs.prompt ?? "");
        }

        const prompt = videoPromptOf(node, context);
        const result = await actionContext.runAction(internal.chat.functions.generateVideo, {
            ...textToVideoArgs(node, prompt, inputs, userId),
            organizationId: context.orgId ?? null,
        });

        return videoNodeOutput(result, prompt);
    });

    return { output };
};
