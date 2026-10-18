/**
 * What a video node reads from its incoming edges, and the checks that run before a workflow starts.
 *
 * Pure apart from the signing callback the executors pass in: no action context is needed here.
 */
import { falVideoFixedSecondsOf, MODEL_LOOKUP, type ModelDefinition, resolveWorkflowModel } from "@neore/ai/models";

import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { sourceNodesOf } from "./core";
import { isFrameHandleId, parseFrameHandle, type FrameKind, TEXT_MENTION_NODE_TYPES } from "./mentions";
import { falDurationInput, referenceVideoLimitSeconds } from "../chat/lib/fal-reference-mapping";

/** Media a video node reads, before it is turned into URLs. */
export type MediaRef = { fileId: string } | { url: string };

export interface VideoInputs {
    /** The start image: the extracted frame of a wired frame handle, or `undefined` when no frame is wired. */
    image?: MediaRef;
    referenceAudios: MediaRef[];
    referenceVideos: MediaRef[];
}

/** The node types whose output is a clip, and whose `duration` the executor requests. */
const VIDEO_OUTPUT_NODE_TYPES = new Set(["image-to-video", "video"]);

/** Stored-file reference, with the MIME type it declares. */
export interface MediaOutput {
    mimeType: string;
    ref: MediaRef;
}

/**
 * The media an upstream output carries. A file node answers `{ name, type, fileId | url }`; a
 * generation answers `{ assets: [{ mimeType, fileId?, videoUrl | audioUrl | imageUrl }] }`, and its
 * first asset is the clip. A stored file is read by id before any provider URL, since a URL expires.
 */
export const mediaOf = (output: unknown): MediaOutput | undefined => {
    if (typeof output !== "object" || output === null) {
        return undefined;
    }

    const object = output as Record<string, unknown>;
    const [first] = Array.isArray(object.assets) ? (object.assets as unknown[]) : [];
    const clip = (first ?? object) as Record<string, unknown>;
    const declaredType = typeof object.type === "string" ? object.type : "";
    const mimeType = typeof clip.mimeType === "string" ? clip.mimeType : declaredType;

    if (typeof clip.fileId === "string") {
        return { mimeType, ref: { fileId: clip.fileId } };
    }

    const url = [clip.videoUrl, clip.audioUrl, clip.url].find((candidate): candidate is string => typeof candidate === "string");

    return url === undefined ? undefined : { mimeType, ref: { url } };
};

/** The frame a video node takes from its clip: the last frame wire into it, and the clip that wire reads. */
export interface FrameSource {
    clip: MediaOutput | undefined;
    kind: FrameKind;
    sourceId: string;
}

/**
 * The frame wire a video node reads, or `undefined` when none is wired. Only the last one counts,
 * the one `resolveVideoInputs` takes as the start image, so a second wire is never extracted.
 */
export const frameSourceOf = (node: WorkflowNode, context: ExecutionContext): FrameSource | undefined => {
    let found: { kind: FrameKind; source: WorkflowNode } | undefined;

    for (const { edge, node: source } of sourceNodesOf(node, context)) {
        const kind = parseFrameHandle(edge.sourceHandle);

        if (kind !== undefined) {
            found = { kind, source };
        }
    }

    return found && { clip: mediaOf(context.nodeOutputs[found.source.id]), kind: found.kind, sourceId: found.source.id };
};

/**
 * What a video node reads from its incoming edges, by handle, not by execution order.
 *
 * A frame wire is the image input, and `frame` is the stored frame extracted for it (see
 * `frameSourceOf`). Any other wire contributes its output as a reference video or audio by MIME
 * type; anything that is neither is ignored.
 */
export const resolveVideoInputs = (node: WorkflowNode, context: ExecutionContext, frame?: MediaRef): VideoInputs => {
    const inputs: VideoInputs = { referenceAudios: [], referenceVideos: [] };

    for (const { edge, node: source } of sourceNodesOf(node, context)) {
        if (isFrameHandleId(edge.sourceHandle)) {
            inputs.image = frame;

            continue;
        }

        const media = mediaOf(context.nodeOutputs[source.id]);

        if (media?.mimeType.startsWith("video/")) {
            inputs.referenceVideos.push(media.ref);
        } else if (media?.mimeType.startsWith("audio/")) {
            inputs.referenceAudios.push(media.ref);
        }
    }

    return inputs;
};

const PUBLIC_HTTP_URL = /^https?:\/\//u;

/**
 * The URLs a provider is given for `refs`. A stored file is signed for the owner
 * (`signFile` answers `null` when the caller holds no grant). A plain URL must be
 * http(s): a `blob:` or `data:` URL is local to the browser and no provider can read it.
 */
export const resolveMediaUrls = async (refs: MediaRef[], signFile: (fileId: string) => Promise<string | null>): Promise<string[]> =>
    await Promise.all(
        refs.map(async (ref) => {
            if ("url" in ref) {
                if (!PUBLIC_HTTP_URL.test(ref.url)) {
                    throw new Error("A reference file is not available as a public URL; upload it again");
                }

                return ref.url;
            }

            const url = await signFile(ref.fileId);

            if (!url) {
                throw new Error("A referenced file is missing or no longer shared with you");
            }

            return url;
        }),
    );

/** Whether a node runs a video model, the two node types the executor sends to the video actions. */
export const isVideoNode = (node: WorkflowNode): boolean => node.type === "video" || node.type === "image-to-video";

/** What a video node does: a text-to-video clip, or an image-to-video one (by its type or its mode). */
export type VideoKind = "textToVideo" | "imageToVideo";

/** The video kind a node runs, as the executor dispatches it. `undefined` for a node that is not a video node. */
export const videoKindOf = (node: WorkflowNode): VideoKind | undefined => {
    if (!isVideoNode(node)) {
        return undefined;
    }

    return node.type === "image-to-video" || node.data.mode === "image-to-video" ? "imageToVideo" : "textToVideo";
};

/**
 * The model id a video node of `kind` runs: the stored id, or the workflow default for the kind
 * (`resolveWorkflowModel`). Every video check and the billing read go through here, so a node is gated and
 * charged for the model it actually runs.
 */
export const modelIdFor = (node: WorkflowNode, kind: VideoKind): string => resolveWorkflowModel(kind, (node.data as { model?: string }).model);

/**
 * The clip length a video node asks for when it sets none, and what the endpoint bills for an endpoint
 * that takes no duration. The gateway bills the same 5 s (`body.duration ?? 5`).
 */
export const DEFAULT_VIDEO_SECONDS = 5;

/** The registry row a video node runs (its resolved model), or `undefined` for a node that is not a video node. */
export const videoDefinitionOf = (node: WorkflowNode): ModelDefinition | undefined => {
    const kind = videoKindOf(node);

    return kind === undefined ? undefined : MODEL_LOOKUP.get(modelIdFor(node, kind));
};

/** A stored duration when it is a positive finite number; anything else counts as unset. */
const validDuration = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/**
 * The one length a video node run uses: `requested` is what the action receives (the node's duration,
 * capped at the row's `maxVideoDuration`, else the default), and `billed` is the length the endpoint is
 * sent, which is what the run is charged for. An endpoint with no duration input is sent nothing, and it
 * bills the default.
 */
export const videoDurationOf = (node: WorkflowNode, definition: ModelDefinition | undefined): { billed: number; requested: number } => {
    const asked = validDuration((node.data as { duration?: unknown }).duration) ?? DEFAULT_VIDEO_SECONDS;
    const requested = definition?.maxVideoDuration === undefined ? asked : Math.min(asked, definition.maxVideoDuration);
    const sent = falDurationInput(definition, requested);
    const sentSeconds = typeof sent === "number" ? sent : Number.parseFloat(String(sent));

    // An endpoint with no duration input is sent nothing: its page fixes the clip length (`falVideoFixedSecondsOf`), else the default.
    return { billed: sent === undefined ? (falVideoFixedSecondsOf(definition?.modelApiId) ?? DEFAULT_VIDEO_SECONDS) : sentSeconds, requested };
};

/**
 * The seconds a generated clip (a video or image-to-video node's output) runs: the length its run bills. The
 * reference budget and a frame's clip length both read it, so a check and a charge cannot disagree on a clip.
 */
export const generatedClipSecondsOf = (node: WorkflowNode): number => videoDurationOf(node, videoDefinitionOf(node)).billed;

/**
 * The provider-readable URLs of a video node's inputs: the start image (a wired frame handle,
 * which wins over the upstream image) and the reference media. A reference video or audio is
 * resolved only when `model` declares a cap for it, otherwise it is ignored as it always was, so
 * an unusable wire (a `blob:` file, a mochi target) cannot abort a run that never used it.
 */
export const resolveVideoInputUrls = async (
    node: WorkflowNode,
    context: ExecutionContext,
    signFile: (fileId: string) => Promise<string | null>,
    model: ModelDefinition | undefined,
    frame?: MediaRef,
) => {
    const inputs = resolveVideoInputs(node, context, frame);
    const [image] = inputs.image ? await resolveMediaUrls([inputs.image], signFile) : [undefined];
    const videoCap = model?.maxReferenceVideos ?? 0;
    const audioCap = model?.maxReferenceAudios ?? 0;

    return {
        image,
        referenceAudioUrls: audioCap > 0 ? await resolveMediaUrls(inputs.referenceAudios.slice(0, audioCap), signFile) : [],
        referenceVideoUrls: videoCap > 0 ? await resolveMediaUrls(inputs.referenceVideos.slice(0, videoCap), signFile) : [],
    };
};

/**
 * The node types whose output is text the prompt path reads as a string (`videoPromptOf`). A wire from any
 * other type (a file, a video) carries media, not a prompt.
 */
const TEXT_OUTPUT_NODE_TYPES: ReadonlySet<string> = new Set([...TEXT_MENTION_NODE_TYPES, "transcription"]);

/**
 * What a video node fed by a frame needs before its paid call: a model that takes an image input
 * (the registry's `supportsImageToVideo`), and a prompt when it runs text-to-video. The prompt is the
 * node's own, when it stores one (`videoPromptOf` reads a stored string before anything wired, even an
 * empty one), else a text wire into it. The run checks the text it actually gets before it extracts the frame.
 */
const frameTargetErrors = (target: WorkflowNode, kind: FrameKind, byId: ReadonlyMap<string, WorkflowNode>, edges: ReadonlyArray<WorkflowEdge>): string[] => {
    const errors: string[] = [];
    const modelId = modelIdFor(target, videoKindOf(target) ?? "textToVideo");

    if (MODEL_LOOKUP.get(modelId)?.supportsImageToVideo !== true) {
        errors.push(`The ${kind} frame needs a model that takes an image input; ${modelId} does not`);
    }

    const hasPrompt =
        typeof target.data.prompt === "string"
            ? target.data.prompt.length > 0
            : edges.some((edge) => {
                  const source = byId.get(edge.source);

                  return edge.target === target.id && !isFrameHandleId(edge.sourceHandle) && source !== undefined && TEXT_OUTPUT_NODE_TYPES.has(source.type);
              });

    if (target.type === "video" && target.data.mode !== "image-to-video" && !hasPrompt) {
        errors.push(`The ${kind} frame feeds a text-to-video node with no prompt; give it a prompt or wire a text node into it`);
    }

    return errors;
};

/** A file node whose declared type is video: a reference clip whose length is not known until it is read. */
const isVideoFile = (node: WorkflowNode): boolean => node.type === "file" && typeof node.data.fileType === "string" && node.data.fileType.startsWith("video/");

/**
 * Checks that need only the graph, run before any node so a doomed run never bills a clip:
 * - a frame wire must name a supported frame (`start` or `end`), run from a video or
 *   image-to-video node into one, and feed a node whose model takes an image (with a prompt when
 *   it is text-to-video);
 * - the upstream generated clips must fit the model's reference-video budget (see `referenceVideoLimitSeconds`), each at the
 *   length its generation bills (`generatedClipSecondsOf`). An uploaded clip of unknown length is not checked.
 *
 * Returns one message per problem, empty when the graph can run.
 */
export const videoInputErrors = (nodes: ReadonlyArray<WorkflowNode>, edges: ReadonlyArray<WorkflowEdge>): string[] => {
    const errors: string[] = [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const frameFed = new Map<string, FrameKind>();

    for (const edge of edges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        const frame = parseFrameHandle(edge.sourceHandle);

        if (!isFrameHandleId(edge.sourceHandle) || !source || !target) {
            continue;
        }

        if (frame === undefined) {
            errors.push(`The ${edge.sourceHandle} handle is no longer supported: add the frame as an image node and wire that instead`);
        } else if (!VIDEO_OUTPUT_NODE_TYPES.has(source.type) || !VIDEO_OUTPUT_NODE_TYPES.has(target.type)) {
            errors.push(`The ${frame} frame must go from a video or image-to-video node into a video or image-to-video node`);
        } else {
            frameFed.set(target.id, frame);
        }
    }

    for (const target of nodes) {
        if (target.type !== "video" && target.type !== "image-to-video") {
            continue;
        }

        const frame = frameFed.get(target.id);

        if (frame !== undefined) {
            errors.push(...frameTargetErrors(target, frame, byId, edges));
        }

        const modelId = modelIdFor(target, videoKindOf(target) ?? "textToVideo");
        const limit = referenceVideoLimitSeconds(MODEL_LOOKUP.get(modelId));

        if (limit === undefined) {
            continue;
        }

        // Only plain wires are reference clips; a frame wire is an image. The runtime takes the first `maxReferenceVideos` video
        // wires (`referenceSecondsOf`), uploads included. An upload's length is not known here, so a set holding one is not totalled.
        const clips = edges
            .filter((edge) => edge.target === target.id && !isFrameHandleId(edge.sourceHandle))
            .map((edge) => byId.get(edge.source))
            .filter((source): source is WorkflowNode => source !== undefined && (VIDEO_OUTPUT_NODE_TYPES.has(source.type) || isVideoFile(source)))
            .slice(0, MODEL_LOOKUP.get(modelId)?.maxReferenceVideos ?? 0);

        if (clips.some((source) => !VIDEO_OUTPUT_NODE_TYPES.has(source.type))) {
            continue;
        }

        // Each generated clip is billed at the length its generation produces, the same as the reference charge.
        const total = clips.reduce((sum, source) => sum + generatedClipSecondsOf(source), 0);

        if (total > limit) {
            errors.push(`The reference clips total ${total}s; ${modelId} accepts at most ${limit}s of reference video`);
        }
    }

    return errors;
};
