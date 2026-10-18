/**
 * The arguments the workflow's action executor and streaming endpoint both send for a node: a
 * video node's provider-readable inputs, an image node's prompt and reference array, an AI node's
 * system prompt, and the one shape a video node stores. Both entry points read these, so the two
 * cannot disagree on what a node sends.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { type ExecutionContext, extractUrl, getLastOutput, type WorkflowContent, type WorkflowNode } from "./core";
import { expandNodeMentions, referenceImageUrls } from "./mention-targets";
import { type FrameSource, frameSourceOf, type MediaRef, modelIdFor, resolveMediaUrls, resolveVideoInputUrls, videoInputErrors } from "./video-inputs";

/** The part of an action or HTTP action context the workflow reads stored files through, and extracts frames with. */
export interface WorkflowFileContext {
    runAction: (
        action: typeof internal.workflow.media_ops.extractVideoFrame,
        args: { frame: "start" | "end"; threadId: string; userId: string; videoUrl: string },
    ) => Promise<{ fileId: string; mimeType: string }>;
    runQuery: (query: typeof api.file.getChatFileImageUrl, args: { fileId: Id<"chatFiles"> }) => Promise<string | null>;
}

/** A stored file's display URL for the workflow's owner; `null` when they hold no grant for it. */
const signChatFile = async (context: WorkflowFileContext, fileId: string): Promise<string | null> =>
    await context.runQuery(api.file.getChatFileImageUrl, { fileId: fileId as Id<"chatFiles"> });

/**
 * The stored file of a frame wire, extracted from its source clip. A frame wired into two nodes is
 * extracted once per run: the promise is kept on the run's context, keyed by source and kind.
 */
const extractedFrameFileId = (context: ExecutionContext, files: WorkflowFileContext, userId: string, source: FrameSource, videoUrl: string) => {
    const frames = context.frames ?? new Map<string, Promise<string>>();

    context.frames = frames;

    const key = `${source.sourceId}:${source.kind}`;
    const known = frames.get(key);

    if (known) {
        return known;
    }

    const pending = files
        .runAction(internal.workflow.media_ops.extractVideoFrame, { frame: source.kind, threadId: "workflow", userId, videoUrl })
        .then((stored) => stored.fileId);

    frames.set(key, pending);

    return pending;
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
    const modelId = modelIdFor(node);
    const model = modelId === undefined ? undefined : MODEL_LOOKUP.get(modelId);
    const sign = (fileId: string) => signChatFile(files, fileId);
    const frame = await frameRefOf(node, context, files, userId, sign);
    const inputs = await resolveVideoInputUrls(node, context, sign, model, frame);

    return {
        frameUrl: inputs.image,
        referenceAudioUrls: inputs.referenceAudioUrls,
        referenceVideoUrls: inputs.referenceVideoUrls,
    };
};

/**
 * A video node's prompt: its own, else the run's latest output when that is text. The one reading both
 * entry points use, so a run and a stream cannot disagree on what a node sends.
 */
export const videoPromptOf = (node: WorkflowNode, context: ExecutionContext): string => {
    const data = node.data as { prompt?: string };
    const inputValue = getLastOutput(context);

    return data.prompt ?? (typeof inputValue === "string" ? inputValue : "");
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

/**
 * The arguments of the image-to-video action for a video node. The options are sent only when the
 * stored value has the type the action takes; the action keeps only the ones the model accepts
 * (`fal-video-inputs.ts`), so a value left over from an earlier model is dropped there.
 */
export const imageToVideoArgs = (node: WorkflowNode, imageUrl: string, inputs: VideoInputArgs, userId: string) => {
    const data = node.data as VideoNodeRunData;

    return {
        duration: data.duration,
        fps: data.fps,
        generateAudio: typeof data.generateAudio === "boolean" ? data.generateAudio : undefined,
        imageUrl,
        model: data.model,
        motionStrength: data.motionStrength,
        prompt: data.prompt,
        referenceAudioUrls: inputs.referenceAudioUrls,
        referenceVideoUrls: inputs.referenceVideoUrls,
        resolution: typeof data.resolution === "string" ? data.resolution : undefined,
        threadId: "workflow",
        userId,
    };
};

/** The arguments of the text-to-video action for a video node, with the node's defaults for what it leaves unset. */
export const textToVideoArgs = (node: WorkflowNode, prompt: string, inputs: VideoInputArgs, userId: string) => {
    const data = node.data as VideoNodeRunData;

    return {
        aspectRatio: data.aspectRatio ?? "16:9",
        duration: data.duration ?? 5,
        generateAudio: typeof data.generateAudio === "boolean" ? data.generateAudio : undefined,
        model: data.model ?? "fal:mochi-v1",
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
    const data = node.data as { mode?: string };

    if (node.type === "image-to-video" || data.mode === "image-to-video") {
        const hasImage = frameSourceOf(node, context) !== undefined || Boolean(extractUrl(getLastOutput(context), "imageUrl"));

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
    | { assets: { mimeType: string; videoUrl: string }[]; modelId: string; prompt: string }
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
export const workflowInputErrors = (content: Pick<WorkflowContent, "edges" | "nodes">): string[] =>
    videoInputErrors(content.nodes, content.edges, (modelId) => MODEL_LOOKUP.get(modelId));
