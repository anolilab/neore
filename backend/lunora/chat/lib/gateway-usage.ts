import { isBillingMode } from "@neore/ai/gateway";
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../_generated/internal";
import { verifySignedRequest } from "../../lib/sign-request";

interface UsageReport {
    billingMode?: unknown;
    byokFeeRate?: unknown;
    completionTokens: number;
    costMicrodollars: number;
    modelId: string;
    orgId?: string;
    promptTokens: number;
    requestId: string;
    userId: string;
}

/**
 * HTTP action handler for POST /gateway/usage-report.
 * Called by the LLM Gateway after each LLM call to deduct credits.
 */
export const gatewayUsageReportHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    // Verify HMAC signature
    const secret = process.env.LLM_GATEWAY_SIGNING_SECRET!;
    const valid = await verifySignedRequest(request, secret);

    if (!valid) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let report: UsageReport;

    try {
        report = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!report.userId || !report.requestId || report.costMicrodollars === undefined) {
        return Response.json({ error: "Missing required fields: userId, requestId, costMicrodollars" }, { status: 400 });
    }

    // Deduct credits — propagate failures so the gateway retries.
    // The mutation is idempotent on requestId, so retries are safe.
    try {
        // The deduction row is the user's: it goes on their shard.
        await context.forShard(report.userId).runMutation(internal.auth.billing.deductCreditsFromGateway, {
            // An unrecognised mode is dropped rather than rejected (a 500 would make the
            // gateway's report fail outright); absent means "platform".
            billingMode: isBillingMode(report.billingMode) ? report.billingMode : undefined,
            byokFeeRate: typeof report.byokFeeRate === "number" ? report.byokFeeRate : undefined,
            costMicrodollars: report.costMicrodollars,
            modelId: report.modelId,
            orgId: report.orgId,
            requestId: report.requestId,
            userId: report.userId,
        });
    } catch (error) {
        console.error("[GatewayUsage] Failed to deduct credits:", error);

        return Response.json({ error: "Failed to deduct credits" }, { status: 500 });
    }

    return Response.json({ ok: true }, { status: 200 });
};
