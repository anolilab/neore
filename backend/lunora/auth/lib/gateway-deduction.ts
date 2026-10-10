import type { BillingMode } from "@neore/ai/gateway";

import type { MutationCtx as MutationContext } from "../../_generated/server";
import { computeGatewayCredits } from "./gateway-credits";

export interface GatewayDeductionArgs {
    billingMode?: BillingMode;
    byokFeeRate?: number;
    costMicrodollars: number;
    modelId: string;
    orgId?: string;
    /** The gateway's per-call id — the idempotency key for usage-report retries. */
    requestId: string;
    userId: string;
}

export type GatewayDeductionOutcome = "deducted" | "duplicate" | "no-charge" | "no-org" | "no-credit-record";

/**
 * Apply one gateway usage report to the member's credits, at most once per
 * `requestId`. The gateway retries a report on 5xx and network errors, so a
 * retry of a report that already landed must be a no-op: the
 * `gatewayUsageDeductions` row written alongside the charge is the dedupe key.
 * Both writes happen in one mutation, so a charge without its row cannot exist.
 */
export const applyGatewayDeduction = async (context: MutationContext, args: GatewayDeductionArgs): Promise<GatewayDeductionOutcome> => {
    const { billingMode, byokFeeRate, costMicrodollars, modelId, orgId, requestId, userId } = args;

    // Full cost for platform keys, the BYOK fee for the user's own key, nothing for custom endpoints.
    const creditsToDeduct = computeGatewayCredits({ billingMode, byokFeeRate, costMicrodollars });

    if (creditsToDeduct <= 0) {
        return "no-charge";
    }

    const priorDeduction = await context.db
        .query("gatewayUsageDeductions")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .first();

    if (priorDeduction) {
        return "duplicate";
    }

    if (!orgId) {
        return "no-org";
    }

    const existingCredits = await context.db.memberCredits.findFirst({ where: { organizationId: orgId, userId } });

    // No record means no org-level billing is configured — nothing to deduct from.
    if (!existingCredits) {
        return "no-credit-record";
    }

    await context.db.patch(existingCredits._id, {
        usedCredits: (existingCredits.usedCredits ?? 0) + creditsToDeduct,
    });

    await context.db.insert("gatewayUsageDeductions", {
        billingMode: billingMode ?? "platform",
        costMicrodollars,
        createdAt: Date.now(),
        creditsDeducted: creditsToDeduct,
        modelId,
        orgId,
        requestId,
        userId,
    });

    return "deducted";
};
