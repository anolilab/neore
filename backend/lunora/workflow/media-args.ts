/**
 * The arguments the workflow's action executor and streaming endpoint both send for a node: a
 * video node's provider-readable inputs, an image node's prompt and reference array, an AI node's
 * system prompt, and the one shape a video node stores. Both entry points read these, so the two
 * cannot disagree on what a node sends.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ExecutionContext, getLastOutput, type WorkflowContent, type WorkflowNode } from "./core";
import { expandNodeMentions, referenceImageUrls } from "./mention-targets";
import { modelIdFor, resolveVideoInputUrls, videoInputErrors } from "./video-inputs";

/** The part of an action or HTTP action context the workflow reads stored files through. */
export interface WorkflowFileContext {
    runQuery: (query: typeof api.file.getChatFileImageUrl, args: { fileId: Id<"chatFiles"> }) => Promise<string | null>;
}

/** A stored file's display URL for the workflow's owner; `null` when they hold no grant for it. */
const signChatFile = async (context: WorkflowFileContext, fileId: string): Promise<string | null> =>
    await context.runQuery(api.file.getChatFileImageUrl, { fileId: fileId as Id<"chatFiles"> });

/**
 * A video node's provider-readable inputs. `frameUrl` is the wired frame alone: the caller decides
 * whether an upstream image may stand in for it, since text-to-video never used one.
 */
export const videoInputArgs = async (node: WorkflowNode, context: ExecutionContext, files: WorkflowFileContext) => {
    const modelId = modelIdFor(node);
    const model = modelId === undefined ? undefined : MODEL_LOOKUP.get(modelId);
    const inputs = await resolveVideoInputUrls(node, context, (fileId) => signChatFile(files, fileId), model);

    return {
        frameUrl: inputs.image,
        referenceAudioUrls: inputs.referenceAudioUrls,
        referenceVideoUrls: inputs.referenceVideoUrls,
    };
};

/** An image node's prompt and reference images. An upstream text output is the prompt when there is one. */
export const imageRequestArgs = (node: WorkflowNode, context: ExecutionContext) => {
    const data = node.data as { prompt?: string };
    const inputPrompt = getLastOutput(context);
    const ownPrompt = data.prompt && expandNodeMentions(node, data.prompt, context);

    return {
        prompt: typeof inputPrompt === "string" ? inputPrompt : ownPrompt,
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
