/**
 * What a workflow video run may use and what it costs, decided from the graph and the registry before
 * any paid call. Pure: the registry is read directly, the plan comes in as an argument.
 */
import { enabledModelOf, FAL_VIDEO, type ModelDefinition, MODEL_LOOKUP, requiresPaidPlan } from "@neore/ai/models";

import { TEXT_TO_VIDEO_PROVIDERS } from "../chat/lib/video-providers";
import { byokPaysFor, paidModelRefusal } from "../chat/lib/paid-model";
import { falDurationInput } from "../chat/lib/fal-reference-mapping";
import type { WorkflowNode } from "./core";
import { modelIdFor, videoKindOf } from "./video-inputs";

/**
 * The clip length a video node asks for when it sets none, and what the endpoint bills for an endpoint
 * that takes no duration. The gateway bills the same 5 s (`body.duration ?? 5`).
 */
export const DEFAULT_VIDEO_SECONDS = 5;

const labelOf = (node: WorkflowNode): string => (typeof node.data.label === "string" && node.data.label.length > 0 ? node.data.label : node.type);

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

    return { billed: sent === undefined ? DEFAULT_VIDEO_SECONDS : sentSeconds, requested };
};

/**
 * The cost of one video node run in microdollars, the unit the gateway prices video in
 * (`costPerSecondMicrodollars` x billed seconds). `undefined` only when the row has no price.
 */
export const videoRunCost = (node: WorkflowNode): { costMicrodollars: number | undefined; seconds: number } => {
    const definition = videoDefinitionOf(node);
    const { billed } = videoDurationOf(node, definition);
    const rate = definition?.costPerSecondMicrodollars;

    return { costMicrodollars: rate === undefined ? undefined : Math.round(billed * rate), seconds: billed };
};

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
 * on a provider the action calls (`TEXT_TO_VIDEO_PROVIDERS`); an image-to-video node needs an enabled fal
 * video row (`FAL_VIDEO`).
 */
export const unrunnableVideoErrors = (nodes: ReadonlyArray<WorkflowNode>): string[] =>
    nodes.flatMap((node) => {
        const kind = videoKindOf(node);

        if (kind === undefined) {
            return [];
        }

        const modelId = modelIdFor(node, kind);

        if (kind === "imageToVideo") {
            return enabledModelOf(modelId, FAL_VIDEO) ? [] : [`The "${labelOf(node)}" node's model ${modelId} is not an enabled fal video model`];
        }

        const definition = enabledModelOf(modelId, { mode: "video" });

        return definition && TEXT_TO_VIDEO_PROVIDERS.includes(definition.provider)
            ? []
            : [`The "${labelOf(node)}" node's model ${modelId} is not an enabled video model`];
    });

/**
 * The idempotency key of one node run's charge. A retry of the same run and node is the same key, so
 * the ledger's `requestId` check makes it a no-op (`auth/lib/gateway-deduction.ts`).
 */
export const videoRequestId = (runId: string, nodeId: string): string => `workflow-video:${runId}:${nodeId}`;
