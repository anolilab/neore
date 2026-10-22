/**
 * The guest refusal and the daily quota for a workflow's paid image and audio nodes. Video nodes keep their
 * own gate (`video-billing.ts`); this file classifies every media node so the two cannot miss one.
 *
 * - before the run (`workflowMediaErrors`): a guest is refused when the graph has any paid media node;
 * - per node, before its paid call (`withMediaCharge`): the daily quota `/chat/media` charges for the same
 *   kind, one unit per image or per comparison model, taken in one charge. It is keyed on the node run, so a
 *   retry takes no second unit. Both dispatchers (`executor.ts` and the streaming endpoint in `http.ts`) pass
 *   each image and audio executor its charge, which it calls after validating its inputs.
 */
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import type { ExecutionContext, WorkflowNode } from "./core";
import type { RunAccount } from "./run-setup";
import { isVideoNode } from "./video-inputs";

export type MediaKind = "Audio" | "Image" | "Video";

const IMAGE_NODE_TYPES = new Set([
    "background-removal",
    "character-ref",
    "controlnet",
    "image",
    "img2img",
    "inpaint",
    "object-editor",
    "outpaint",
    "parallel-compare",
    "style-ref",
    "upscale",
]);

const AUDIO_NODE_TYPES = new Set(["audio", "transcription"]);

/** The daily quota a node's run draws on; `undefined` for a node that makes no paid media call (an `input` image node runs nothing). */
export const mediaKindOf = (node: WorkflowNode): MediaKind | undefined => {
    if (isVideoNode(node)) {
        return "Video";
    }

    if (node.type === "image" && node.data.mode === "input") {
        return undefined;
    }

    if (IMAGE_NODE_TYPES.has(node.type)) {
        return "Image";
    }

    return AUDIO_NODE_TYPES.has(node.type) ? "Audio" : undefined;
};

/** A guest may not run a graph with a paid media node. `workflowVideoErrors` already says so for video, so it is not repeated then. */
export const workflowMediaErrors = (account: RunAccount, nodes: ReadonlyArray<WorkflowNode>): string[] => {
    if (!account.isAnonymous || nodes.some((node) => isVideoNode(node)) || nodes.every((node) => mediaKindOf(node) === undefined)) {
        return [];
    }

    return ["Create an account to generate media in a workflow"];
};

/** The request id one node run's daily unit is taken under. */
export const mediaRequestId = (runId: string, nodeId: string): string => `workflow-media:${JSON.stringify([runId, nodeId])}`;

/** The most images one image node run may generate: the cap `/chat/media` applies per request. */
const MAX_IMAGES_PER_NODE = 4;

/** The number of images an image node asks for, clamped to the cap; a request carries whatever the client sent. */
export const imageCountOf = (numberImages: number | undefined): number =>
    Math.min(MAX_IMAGES_PER_NODE, Math.max(1, Math.trunc(Number(numberImages ?? 1)) || 1));

/**
 * Takes `count` daily units for one node run, right before the paid call that uses them. A spent quota throws
 * there, so an input that fails validation never draws a unit. Calling it again for the same run takes nothing.
 */
export type MediaCharge = (count: number) => Promise<void>;

/**
 * Runs `execute` with the charge for an image or audio node run. Other node kinds get a no-op charge.
 * The executor calls it once, after validating its inputs and before its paid call.
 */
export const withMediaCharge = async <T>(
    context: Pick<ActionCtx, "runMutation">,
    run: ExecutionContext,
    node: WorkflowNode,
    userId: string,
    execute: (charge: MediaCharge) => Promise<T>,
): Promise<T> => {
    const kind = mediaKindOf(node);

    const charge: MediaCharge = async (count) => {
        if (kind !== "Image" && kind !== "Audio") {
            return;
        }

        const charged = await context.runMutation(internal.chat.daily_charge.chargeDailyUnit, {
            count,
            kind,
            organizationId: run.orgId,
            requestId: mediaRequestId(run.runId, node.id),
            userId,
        });

        if (!charged) {
            throw new Error(`You've reached your daily ${kind.toLowerCase()} generation limit.`);
        }
    };

    return await execute(charge);
};
