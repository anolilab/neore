/**
 * What a workflow video run may use and what it costs, decided from the graph and the registry before
 * any paid call. Pure: the registry is read directly, the plan comes in as an argument.
 */
import { enabledModelOf, exceedsFreePlanCap, falVideoMicrodollarsOf, requiresPaidPlan, WORKFLOW_KIND_ACCEPTS } from "@neore/ai/models";

import { TEXT_TO_VIDEO_PROVIDERS } from "../chat/lib/video-providers";
import { byokPaysFor, paidModelRefusal } from "../chat/lib/paid-model";
import { falVideoOptionInput } from "../chat/lib/fal-reference-mapping";
import type { FrameKind } from "./mentions";
import { isFrameHandleId } from "./mentions";
import type { WorkflowEdge, WorkflowNode } from "./core";
import {
    DEFAULT_VIDEO_SECONDS,
    generatedClipSecondsOf,
    isVideoNode,
    modelIdFor,
    videoDefinitionOf,
    videoDurationOf,
    videoKindOf,
    wireRoleOf,
} from "./video-inputs";

/**
 * An injective encoding of a tuple of ids into one request-id segment. Ids are user-controlled strings, so a
 * plain `:` join is ambiguous: (`a:b`, `c`) and (`a`, `b:c`) would share a key, and a charge would dedupe
 * against another's. JSON quotes and escapes every element, so no two tuples encode alike.
 */
const encodeKey = (parts: ReadonlyArray<string>): string => JSON.stringify(parts);

const labelOf = (node: WorkflowNode): string => (typeof node.data.label === "string" && node.data.label.length > 0 ? node.data.label : node.type);

/**
 * What one video node run costs in microdollars, from the options the action sends: the same snap and
 * free-plan clamp the action applies (`falVideoOptionInput`, with its `premium` flag), the billed length,
 * the start image and the reference videos. `paidPlan` is the action's own plan read (`readRunPlan`).
 * `undefined` for an unpriced row (`UNPRICED_FAL_VIDEO`).
 */
export const videoRunCost = (
    node: WorkflowNode,
    options: { paidPlan: boolean; referenceSeconds: number; startImage: boolean },
): { costMicrodollars: number | undefined; seconds: number } => {
    const definition = videoDefinitionOf(node);
    const { billed } = videoDurationOf(node, definition);
    const data = node.data as { generateAudio?: unknown; resolution?: unknown };
    const resolution = typeof data.resolution === "string" ? data.resolution : undefined;
    const generateAudio = typeof data.generateAudio === "boolean" ? data.generateAudio : undefined;
    // The action's own clamp: `premium` is set by `exceedsFreePlanCap` and the plan, as in `generateVideo`.
    const premium = exceedsFreePlanCap(definition?.modelApiId, resolution) && options.paidPlan;
    const sent = falVideoOptionInput(definition, { generateAudio, resolution }, premium);
    const costMicrodollars = falVideoMicrodollarsOf(definition?.modelApiId, {
        images: options.startImage ? 1 : 0,
        options: { generateAudio: sent.generate_audio, resolution: sent.resolution },
        referenceSeconds: options.referenceSeconds,
        seconds: billed,
    });

    return { costMicrodollars, seconds: billed };
};

/** fal's frame extraction bills the clip it reads: $0.0002 a second, in microdollars. */
export const FRAME_EXTRACT_MICRODOLLARS_PER_SECOND = 200;

/** The clip length a frame is cut from: its source video node's billed length, or the default when it is not a video node. */
export const frameClipSeconds = (source: WorkflowNode | undefined): number =>
    source && isVideoNode(source) ? generatedClipSecondsOf(source) : DEFAULT_VIDEO_SECONDS;

/** What one frame extraction costs, in microdollars, for a clip of `seconds`. */
export const frameExtractionMicrodollars = (seconds: number): number => Math.ceil(seconds * FRAME_EXTRACT_MICRODOLLARS_PER_SECOND);

/** The idempotency key of one frame extraction. Keyed on the source clip and kind, which is how the run memoizes it. */
export const frameRequestId = (runId: string, sourceId: string, kind: FrameKind): string => `workflow-frame:${encodeKey([runId, sourceId, kind])}`;

/**
 * One line per video node whose model needs a paid plan, for a run that is not on one. Names the node
 * and the model. Empty when `canUsePremium` (a paid plan or an admin). A video row is never paid with the
 * user's key (`byokPaysFor`), so the plan alone decides.
 */
export const premiumVideoErrors = (nodes: ReadonlyArray<WorkflowNode>, canUsePremium: boolean): string[] => {
    if (canUsePremium) {
        return [];
    }

    return nodes.flatMap((node) => {
        const definition = videoDefinitionOf(node);

        if (!definition || !requiresPaidPlan(definition)) {
            return [];
        }

        return [`The "${labelOf(node)}" node: ${paidModelRefusal(definition.name ?? definition.id, byokPaysFor(definition))}`];
    });
};

/**
 * One line per video node the video actions refuse whatever the plan, so a doomed run is stopped before any
 * node spends a daily unit. Uses the actions' own rules: a text-to-video node needs an enabled video row
 * on a provider the action calls (`TEXT_TO_VIDEO_PROVIDERS`); an image-to-video node needs an enabled fal row that
 * takes an image input (the `imageToVideo` accept rule in the registry package).
 */
export const unrunnableVideoErrors = (nodes: ReadonlyArray<WorkflowNode>, edges: ReadonlyArray<WorkflowEdge> = []): string[] =>
    nodes.flatMap((node) => {
        const kind = videoKindOf(node);

        if (kind === undefined) {
            return [];
        }

        const modelId = modelIdFor(node, kind);

        if (kind === "imageToVideo") {
            return enabledModelOf(modelId, WORKFLOW_KIND_ACCEPTS.imageToVideo)
                ? []
                : [`The "${labelOf(node)}" node's model ${modelId} is not an enabled fal image-to-video model`];
        }

        const definition = enabledModelOf(modelId, { mode: "video" });

        if (!definition || !TEXT_TO_VIDEO_PROVIDERS.includes(definition.provider)) {
            return [`The "${labelOf(node)}" node's model ${modelId} is not an enabled video model`];
        }

        // An image-only model fails in the action without a start image, after the daily unit is spent: the node needs
        // a frame wire or a wire from an image source.
        if (definition.supportsImageToVideo && !definition.supportsTextToVideo && !hasImageSource(node, nodes, edges)) {
            return [`The "${labelOf(node)}" node's model ${modelId} needs an image input; wire in an image or a frame`];
        }

        return [];
    });

/** Whether `node` has an incoming frame wire or a wire from a source that provides an image. */
const hasImageSource = (node: WorkflowNode, nodes: ReadonlyArray<WorkflowNode>, edges: ReadonlyArray<WorkflowEdge>): boolean =>
    edges.some((edge) => {
        if (edge.target !== node.id) {
            return false;
        }

        if (isFrameHandleId(edge.sourceHandle)) {
            return true;
        }

        const source = nodes.find((candidate) => candidate.id === edge.source);

        return source !== undefined && wireRoleOf(source) === "image";
    });

/**
 * The idempotency key of one node run's charge. A retry of the same run and node is the same key, so
 * the ledger's `requestId` check makes it a no-op (`auth/lib/gateway-deduction.ts`).
 */
export const videoRequestId = (runId: string, nodeId: string): string => `workflow-video:${encodeKey([runId, nodeId])}`;
