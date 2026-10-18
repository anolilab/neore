/**
 * What a video node reads from its incoming edges, and the checks that run before a workflow starts.
 *
 * Pure apart from the signing callback the executors pass in: no action context is needed here.
 */
import type { ModelDefinition } from "@neore/ai/models";

import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { sourceNodesOf } from "./core";
import { isFrameHandleId, parseFrameHandle, type FrameKind } from "./mentions";
import { referenceVideoLimitSeconds } from "../chat/lib/fal-reference-mapping";

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

/**
 * The model a video node's action will call. A text-to-video node falls back to the same default
 * the executor uses; an image-to-video node with no model calls no registry entry at all.
 */
export const modelIdFor = (node: WorkflowNode): string | undefined => {
    const data = node.data as { mode?: string; model?: string };

    if (node.type === "video" && data.mode !== "image-to-video") {
        return data.model ?? "fal:mochi-v1";
    }

    return data.model;
};

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
 * A clip's length in seconds as the graph fixes it: its requested `duration`, or the 5 s the
 * executor asks a text-to-video node for. Unknown counts as 0, so it never trips the check.
 */
const knownDurationOf = (source: WorkflowNode): number => {
    const data = source.data as { duration?: unknown; mode?: string };

    if (typeof data.duration === "number") {
        return data.duration;
    }

    return source.type === "video" && data.mode !== "image-to-video" ? 5 : 0;
};

/**
 * Checks that need only the graph, run before any node so a doomed run never bills a clip:
 * - a frame wire must name a supported frame (`start` or `end`), run from a video or
 *   image-to-video node into one, and feed a node whose model takes an image (with a prompt when
 *   it is text-to-video);
 * - the upstream clips with a known duration must fit the model's reference-video budget
 *   (see `referenceVideoLimitSeconds`). Unknown durations (an uploaded file) are not checked.
 *
 * Returns one message per problem, empty when the graph can run.
 */
/**
 * What a video node fed by a frame needs before its paid call: a model that takes an image input
 * (the registry's `supportsImageToVideo`), and a prompt when it runs text-to-video. A prompt wired
 * as text counts here; the run checks the text it actually gets before it extracts the frame.
 */
const frameTargetErrors = (
    target: WorkflowNode,
    kind: FrameKind,
    edges: ReadonlyArray<WorkflowEdge>,
    modelOf: (modelId: string) => ModelDefinition | undefined,
): string[] => {
    const errors: string[] = [];
    const modelId = modelIdFor(target);

    const model = modelId === undefined ? undefined : modelOf(modelId);

    if (model?.supportsImageToVideo !== true) {
        errors.push(
            modelId === undefined
                ? `The ${kind} frame needs a model that takes an image input, and no model is selected`
                : `The ${kind} frame needs a model that takes an image input; ${modelId} does not`,
        );
    }

    const hasPrompt =
        (typeof target.data.prompt === "string" && target.data.prompt.length > 0) ||
        edges.some((edge) => edge.target === target.id && !isFrameHandleId(edge.sourceHandle));

    if (target.type === "video" && target.data.mode !== "image-to-video" && !hasPrompt) {
        errors.push(`The ${kind} frame feeds a text-to-video node with no prompt; give it a prompt or wire a text node into it`);
    }

    return errors;
};

export const videoInputErrors = (
    nodes: ReadonlyArray<WorkflowNode>,
    edges: ReadonlyArray<WorkflowEdge>,
    modelOf: (modelId: string) => ModelDefinition | undefined,
): string[] => {
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
            errors.push(...frameTargetErrors(target, frame, edges, modelOf));
        }

        const modelId = modelIdFor(target);
        const limit = referenceVideoLimitSeconds(modelId === undefined ? undefined : modelOf(modelId));

        if (limit === undefined) {
            continue;
        }

        // Only plain wires are reference clips; a frame wire is an image.
        const total = edges
            .filter((edge) => edge.target === target.id && !isFrameHandleId(edge.sourceHandle))
            .map((edge) => byId.get(edge.source))
            .filter((source): source is WorkflowNode => source !== undefined && VIDEO_OUTPUT_NODE_TYPES.has(source.type))
            .reduce((sum, source) => sum + knownDurationOf(source), 0);

        if (total > limit) {
            errors.push(`The reference clips total ${total}s; ${modelId} accepts at most ${limit}s of reference video`);
        }
    }

    return errors;
};
