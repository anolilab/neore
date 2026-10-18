/**
 * The checks and charges around a workflow video run. Both run paths (the action executor and the
 * streaming endpoint) reach a video node through `runVideoNode` (`media-args.ts`), which calls
 * `runBilledVideo` here, so a node cannot spend without the checks or skip its charge.
 *
 * - before the run (`workflowVideoErrors`): a guest is refused, and so is a paid-plan video model
 *   the run's account cannot pay for (`premiumVideoErrors`);
 * - per node, before any paid work: the credits the node's paid calls cost must fit the member's remaining
 *   credits, when the account has a credit record. The calls are the clip and, when this node is the first
 *   to need it in the run, the frame extracted for it. The node run takes one unit of the daily video quota that
 *   `/chat/media` and the chat video tool take, once: a retry of the same node finds it taken (frame extraction takes none);
 * - per node, after a clip is made: its cost is deducted from the account's credits, keyed on the run and
 *   node so a retry is a no-op. A failed generation settles nothing, so it is not charged.
 * - per frame extraction: charged by the extraction action (`media-ops.ts`) once fal has accepted the request,
 *   whatever happens after. Keyed on the run and source clip, so a second node reading the frame pays nothing.
 *
 * The account is the run's organization, or the user's own when the run has none (`run-setup.ts`). With no
 * organization or no credit record nothing is charged or refused, as in chat (`applyGatewayDeduction`).
 */
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { computeGatewayCredits } from "../auth/lib/gateway-credits";
import { chatLogger } from "../lib/logger";
import type { ExecutionContext, WorkflowNode } from "./core";
import { isVideoNode, modelIdFor, videoKindOf } from "./video-inputs";
import { premiumVideoErrors, unrunnableVideoErrors, videoRequestId } from "./video-policy";
import type { RunAccount } from "./run-setup";

/** The part of an action or HTTP action context a run's charges go through. */
type RunContext = Pick<ActionCtx, "runMutation" | "runQuery">;

/** The paid calls one node run makes, in microdollars: its clip, and the frame it extracts when it is the first to need it. */
export interface VideoRunCosts {
    clipMicrodollars: number | undefined;
    extractionMicrodollars: number | undefined;
}

/**
 * The graph-wide refusals for a run's video nodes, checked with the other input errors before any node
 * runs. Empty when the graph has no video node.
 */
export const workflowVideoErrors = (account: RunAccount, nodes: ReadonlyArray<WorkflowNode>): string[] => {
    if (nodes.every((candidate) => !isVideoNode(candidate))) {
        return [];
    }

    // Refused before any charge: these runs could never reach their paid call.
    const refusals = unrunnableVideoErrors(nodes);

    if (refusals.length > 0) {
        return refusals;
    }

    if (account.isAnonymous) {
        return ["Create an account to generate video in a workflow"];
    }

    return premiumVideoErrors(nodes, account.isAdmin || account.plan === "premium");
};

const creditsOf = (costMicrodollars: number): number => computeGatewayCredits({ billingMode: "platform", costMicrodollars });

/**
 * Refuses a video node run before its paid work: the credits its paid calls cost, then the daily quota.
 * Throws the message the run reports.
 */
const beginVideoRun = async (context: RunContext, run: ExecutionContext, node: WorkflowNode, userId: string, costs: VideoRunCosts): Promise<void> => {
    const calls = [costs.clipMicrodollars, costs.extractionMicrodollars].filter((cost): cost is number => cost !== undefined);

    if (calls.length > 0 && run.orgId) {
        const { creditsLeft } = await context.runQuery(internal.auth.billing.creditsLeftQuery, { orgId: run.orgId, userId });
        const credits = calls.reduce((sum, cost) => sum + creditsOf(cost), 0);

        if (creditsLeft !== null && credits > creditsLeft) {
            throw new Error(
                `Not enough credits for the "${String(node.data.label ?? node.type)}" video: it costs ${credits} and ${Math.max(creditsLeft, 0)} are left`,
            );
        }
    }

    // The same unit `/chat/media` charges: the tier and the admin exemption are read where the quota is kept. Keyed on the node run,
    // so a retry of it takes no second unit.
    const charged = await context.runMutation(internal.chat.daily_charge.chargeDailyUnit, {
        kind: "Video",
        organizationId: run.orgId,
        requestId: videoRequestId(run.runId, node.id),
        userId,
    });

    if (!charged) {
        throw new Error("You've reached your daily video generation limit.");
    }
};

/**
 * Deducts one paid call's cost from the account's credits, keyed on `requestId` so a retry is a no-op. A call
 * with no organization is not charged. A failure is logged and not thrown: the paid work already happened.
 */
export const chargePaidCall = async (
    context: Pick<ActionCtx, "runMutation">,
    call: { costMicrodollars: number; modelId: string; orgId: string | undefined; requestId: string },
    userId: string,
): Promise<void> => {
    if (!call.orgId) {
        return;
    }

    try {
        await context.runMutation(internal.auth.billing.deductCreditsFromGateway, {
            billingMode: "platform",
            costMicrodollars: call.costMicrodollars,
            modelId: call.modelId,
            orgId: call.orgId,
            requestId: call.requestId,
            userId,
        });
    } catch (error) {
        // The clip or frame exists and fal is paid: failing the node would hide a finished result and invite a paid re-run.
        // The charge is lost instead, and the log is where it is found.
        chatLogger.error("[workflow] could not record a video charge", { error, requestId: call.requestId });
    }
};

/**
 * One video node run, billed: begin (credits, quota), then `dispatch` (frame extraction, inputs and the paid
 * call), then the clip's charge. Charging only after `dispatch` returns means a failed clip is never charged.
 * The extraction's own charge is made where the extraction runs (`media-args.ts`), since only the first node
 * to read a frame pays for it.
 */
export const runBilledVideo = async <T>(
    context: RunContext,
    run: ExecutionContext,
    node: WorkflowNode,
    userId: string,
    costs: VideoRunCosts,
    dispatch: () => Promise<T>,
): Promise<T> => {
    await beginVideoRun(context, run, node, userId, costs);

    const result = await dispatch();

    if (costs.clipMicrodollars !== undefined) {
        const kind = videoKindOf(node);

        await chargePaidCall(
            context,
            {
                costMicrodollars: costs.clipMicrodollars,
                modelId: kind === undefined ? "" : modelIdFor(node, kind),
                orgId: run.orgId,
                requestId: videoRequestId(run.runId, node.id),
            },
            userId,
        );
    }

    return result;
};
