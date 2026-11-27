import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Whether the export request behind a usage export run is still in flight: pending or processing. A run's key is its request's id
 * followed by the workflow instance (`<requestId>:<instance>`). A request that is gone is not in flight.
 *
 * The usage module asks this rather than reading the request table itself, so a status the gdpr module adds or renames is seen here.
 */
export const isExportRequestInFlight = async (ctx: MutationCtx | QueryCtx, runKey: string, userId: string): Promise<boolean> => {
    const request = await ctx.db.gdprRequests.findFirst({
        consistency: "primary",
        where: { _id: runKey.split(":", 1)[0] as Id<"gdprRequests">, userId },
    });

    return request?.status === "pending" || request?.status === "processing";
};
