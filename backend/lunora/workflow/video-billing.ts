/**
 * The checks and charges around a workflow video run. Both run paths (the action executor and the
 * streaming endpoint) reach a video node through `runVideoNode` (`media-args.ts`), which calls
 * `runBilledVideo` here, so a node cannot spend without the checks or skip its charge.
 *
 * - before the run (`workflowVideoErrors`): a guest is refused, and so is a paid-plan video model
 *   the run's account cannot pay for (`premiumVideoErrors`);
 * - per node, before any paid work (frame extraction included): the credits the clip costs must fit the
 *   member's remaining credits, when the account has a credit record, and the run takes one unit of the
 *   daily video quota that `/chat/media` and the chat video tool take;
 * - per node, after a clip is made: its cost is deducted from the account's credits, keyed on the run and
 *   node so a retry is a no-op. A failed generation settles nothing, so it is not charged.
 *
 * The account is the run's organization, or the user's own when the run has none (`run-setup.ts`). With no
 * organization or no credit record nothing is charged or refused, as in chat (`applyGatewayDeduction`).
 * Frame extraction is paid on fal as well, at a price this module does not know, so it is not billed.
 */
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { computeGatewayCredits } from "../auth/lib/gateway-credits";
import { chatLogger } from "../lib/logger";
import type { ExecutionContext, WorkflowNode } from "./core";
import { isVideoNode, modelIdFor, videoKindOf } from "./video-inputs";
import { premiumVideoErrors, unrunnableVideoErrors, videoRequestId, videoRunCost } from "./video-policy";
import type { RunAccount } from "./run-setup";

/** The part of an action or HTTP action context a run's charges go through. */
type RunContext = Pick<ActionCtx, "runMutation" | "runQuery">;

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

/**
 * Refuses a video node run before its paid work: the credits its clip costs, then the daily quota.
 * Throws the message the run reports. A node with no price is not checked against credits.
 */
const beginVideoRun = async (context: RunContext, run: ExecutionContext, node: WorkflowNode, userId: string): Promise<void> => {
    const { costMicrodollars } = videoRunCost(node);

    if (costMicrodollars !== undefined && run.orgId) {
        const { creditsLeft } = await context.runQuery(internal.auth.billing.creditsLeftQuery, { orgId: run.orgId, userId });
        const credits = computeGatewayCredits({ billingMode: "platform", costMicrodollars });

        if (creditsLeft !== null && credits > creditsLeft) {
            throw new Error(
                `Not enough credits for the "${String(node.data.label ?? node.type)}" video: it costs ${credits} and ${Math.max(creditsLeft, 0)} are left`,
            );
        }
    }

    // The same unit `/chat/media` charges: the tier and the admin exemption are read where the quota is kept.
    const charged = await context.runMutation(internal.chat.daily_charge.chargeDailyUnit, { kind: "Video", organizationId: run.orgId, userId });

    if (!charged) {
        throw new Error("You've reached your daily video generation limit.");
    }
};

/** Deducts a finished clip's cost from the account's credits. Keyed on the run and node, so a retry is a no-op. */
const settleVideoRun = async (context: RunContext, run: ExecutionContext, node: WorkflowNode, userId: string): Promise<void> => {
    const { costMicrodollars } = videoRunCost(node);

    if (costMicrodollars === undefined || !run.orgId) {
        return;
    }

    const kind = videoKindOf(node);

    try {
        await context.runMutation(internal.auth.billing.deductCreditsFromGateway, {
            billingMode: "platform",
            costMicrodollars,
            modelId: kind === undefined ? "" : modelIdFor(node, kind),
            orgId: run.orgId,
            requestId: videoRequestId(run.runId, node.id),
            userId,
        });
    } catch (error) {
        // The clip exists and fal is paid: failing the node would hide a finished clip and invite a paid re-run.
        // The charge is lost instead, and the log is where it is found.
        chatLogger.error("[workflow] could not record a video charge", { error, nodeId: node.id, runId: run.runId });
    }
};

/**
 * One video node run, billed: begin (credits, quota), then `dispatch` (inputs and the paid call), then
 * settle. Settling only after `dispatch` returns means a failed clip is never charged; `beginVideoRun` runs
 * before the frame is extracted, which is paid too.
 */
export const runBilledVideo = async <T>(
    context: RunContext,
    run: ExecutionContext,
    node: WorkflowNode,
    userId: string,
    dispatch: () => Promise<T>,
): Promise<T> => {
    await beginVideoRun(context, run, node, userId);

    const result = await dispatch();

    await settleVideoRun(context, run, node, userId);

    return result;
};
