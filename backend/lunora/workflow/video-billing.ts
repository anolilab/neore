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
 * - per node, the clip's cost is reserved from the account's credits in the same mutation as its check
 *   (`reserveGatewayCredits`), so two runs cannot both spend one balance. A run that makes no clip gives the
 *   reservation back (`releaseGatewayCredits`), so a failed generation is not charged. Once a clip is made, its
 *   charge is posted under the reservation's request id, and `chargePaidCall` is then a no-op. A deduction that
 *   fails is retried once, then recorded as a claim the next sweep deducts again; the clip is returned either way,
 *   since the paid work is done.
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
import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
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
export const workflowVideoErrors = (account: RunAccount, nodes: ReadonlyArray<WorkflowNode>, edges: ReadonlyArray<WorkflowEdge> = []): string[] => {
    if (nodes.every((candidate) => !isVideoNode(candidate))) {
        return [];
    }

    // Refused before any charge: these runs could never reach their paid call.
    const refusals = unrunnableVideoErrors(nodes, edges);

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
const beginVideoRun = async (context: RunContext, run: ExecutionContext, node: WorkflowNode, userId: string, costs: VideoRunCosts): Promise<boolean> => {
    // A retry of the node finds its clip already reserved by an earlier attempt, so the snapshot counts only what is still to be taken.
    const clipTaken =
        costs.clipMicrodollars !== undefined &&
        !!run.orgId &&
        (await context.runQuery(internal.auth.billing.gatewayDeductionTakenQuery, { requestId: videoRequestId(run.runId, node.id) }));
    const calls = [clipTaken ? undefined : costs.clipMicrodollars, costs.extractionMicrodollars].filter((cost): cost is number => cost !== undefined);

    if (calls.length > 0 && run.orgId) {
        const { creditsLeft } = await context.runQuery(internal.auth.billing.creditsLeftQuery, { orgId: run.orgId, userId });
        const credits = calls.reduce((sum, cost) => sum + creditsOf(cost), 0);

        if (creditsLeft !== null && credits > creditsLeft) {
            throw new Error(
                `Not enough credits for the "${String(node.data.label ?? node.type)}" video: it costs ${credits} and ${Math.max(creditsLeft, 0)} are left`,
            );
        }
    }

    // The clip is taken with its own check in one mutation, so two runs cannot both pass the snapshot above on one balance.
    // `reserved` is true only when this attempt took the reservation: a retry finds an earlier attempt's, and gives nothing back.
    let reserved = false;

    if (costs.clipMicrodollars !== undefined && run.orgId) {
        const outcome = await context.runMutation(internal.auth.billing.reserveGatewayCredits, {
            costMicrodollars: costs.clipMicrodollars,
            modelId: clipModelIdOf(node),
            orgId: run.orgId,
            requestId: videoRequestId(run.runId, node.id),
            userId,
        });

        if (outcome === "refused") {
            throw new Error(`Not enough credits for the "${String(node.data.label ?? node.type)}" video`);
        }

        reserved = outcome === "taken";
    }

    // The same unit `/chat/media` charges: the tier and the admin exemption are read where the quota is kept. Keyed on the node run,
    // so a retry of it takes no second unit. Any failure here, a refusal or a throw, gives the clip's reservation back.
    try {
        const charged = await context.runMutation(internal.chat.daily_charge.chargeDailyUnit, {
            kind: "Video",
            organizationId: run.orgId,
            requestId: videoRequestId(run.runId, node.id),
            userId,
        });

        if (!charged) {
            throw new Error("You've reached your daily video generation limit.");
        }
    } catch (error) {
        await releaseClip(context, run, node, reserved);

        throw error;
    }

    return reserved;
};

/** The model the clip is charged to, as the ledger records it. */
const clipModelIdOf = (node: WorkflowNode): string => {
    const kind = videoKindOf(node);

    return kind === undefined ? "" : modelIdFor(node, kind);
};

/**
 * Gives back the clip's reservation when no clip was made. A failed release leaves the reservation taken, so the
 * member is charged for a clip they did not get. It is tried twice, like a deduction; a release that fails both
 * times is logged, and is a residual ceiling.
 */
const releaseClip = async (context: Pick<ActionCtx, "runMutation">, run: ExecutionContext, node: WorkflowNode, reserved: boolean): Promise<void> => {
    if (!reserved) {
        return;
    }

    const requestId = videoRequestId(run.runId, node.id);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            await context.runMutation(internal.auth.billing.releaseGatewayCredits, { requestId });

            return;
        } catch (error) {
            chatLogger.error("[workflow] video credit reservation could not be released", { attempt, error, requestId });
        }
    }
};

/** A paid call's charge, keyed on its request id so a repeat of it is a no-op on the ledger. */
interface Charge {
    costMicrodollars: number;
    modelId: string;
    orgId: string;
    requestId: string;
}

/** The deduction for one charge, as `deductCreditsFromGateway` takes it. */
const deductionOf = (charge: Charge, userId: string) => {
    return {
        billingMode: "platform" as const,
        costMicrodollars: charge.costMicrodollars,
        modelId: charge.modelId,
        orgId: charge.orgId,
        requestId: charge.requestId,
        userId,
    };
};

/** One deduction attempt. A failure is logged and reported as `false`, never thrown. */
const deductOnce = async (context: Pick<ActionCtx, "runMutation">, charge: Charge, userId: string): Promise<boolean> => {
    try {
        await context.runMutation(internal.auth.billing.deductCreditsFromGateway, deductionOf(charge, userId));

        return true;
    } catch (error) {
        chatLogger.warn("[workflow] video charge attempt failed", { error, modelId: charge.modelId, requestId: charge.requestId });

        return false;
    }
};

/** The claim scope a charge that could not be deducted is recorded under; its key is the charge's request id. */
const CHARGE_RECORD_SCOPE = "video-charge";

/**
 * How long a recorded charge waits before the next sweep retries it. `reapLapsedClaims` runs on the cron tick (root) and on
 * shard housekeeping (user shards), so a lapse is found within minutes, not at this exact deadline.
 */
const CHARGE_RETRY_LEASE_MS = 60 * 1000;

/** Long enough for the sweep to find the record; the claim purge drops it after. */
const CHARGE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deducts one paid call's cost from the account's credits, keyed on `requestId` so a retry is a no-op. A call
 * with no organization is not charged.
 *
 * The paid work already happened, so this never throws: a finished clip is returned even if its charge fails.
 * The deduction is retried once at once. If both attempts fail, the charge is recorded as a claim (`video-charge`)
 * whose lease lapses on the next sweep; `reapLapsedClaims` then runs the same deduction with the same request id,
 * and the ledger makes a second run of it a no-op. A lapse runs once: if that deduction also fails, nothing retries
 * it, and the scheduler's failure is the only trace (a residual limit).
 */
export const chargePaidCall = async (
    context: Pick<ActionCtx, "runMutation">,
    call: { costMicrodollars: number; modelId: string; orgId: string | undefined; requestId: string },
    userId: string,
): Promise<void> => {
    if (!call.orgId) {
        return;
    }

    const charge: Charge = { costMicrodollars: call.costMicrodollars, modelId: call.modelId, orgId: call.orgId, requestId: call.requestId };

    if (await deductOnce(context, charge, userId)) {
        return;
    }

    if (await deductOnce(context, charge, userId)) {
        return;
    }

    try {
        const recorded = await context.runMutation(internal.lib.claim_once.claimKey, {
            key: charge.requestId,
            leaseMs: CHARGE_RETRY_LEASE_MS,
            // The sweep adds `claimKey` to these args; `deductCreditsFromGateway` strips it (`v.object` drops unknown keys).
            onLapse: { args: JSON.stringify(deductionOf(charge, userId)), target: internal.auth.billing.deductCreditsFromGateway.__lunoraRef },
            scope: CHARGE_RECORD_SCOPE,
            ttlMs: CHARGE_RECORD_TTL_MS,
            userId,
        });

        // `recorded` is `false` when a record for this request id already existed: that record's own lease then decides whether a sweep runs it again.
        chatLogger.error("[workflow] video charge failed twice; recorded for the next sweep", {
            modelId: charge.modelId,
            recorded,
            requestId: charge.requestId,
        });
    } catch (error) {
        chatLogger.error("[workflow] video charge could not be recorded", { error, modelId: charge.modelId, requestId: charge.requestId });
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
    const reserved = await beginVideoRun(context, run, node, userId, costs);

    let result: T;

    try {
        result = await dispatch();
    } catch (error) {
        await releaseClip(context, run, node, reserved);

        throw error;
    }

    if (costs.clipMicrodollars !== undefined) {
        // The reservation in `beginVideoRun` already posted this request id, so the ledger makes this a no-op.
        await chargePaidCall(
            context,
            {
                costMicrodollars: costs.clipMicrodollars,
                modelId: clipModelIdOf(node),
                orgId: run.orgId,
                requestId: videoRequestId(run.runId, node.id),
            },
            userId,
        );
    }

    return result;
};
