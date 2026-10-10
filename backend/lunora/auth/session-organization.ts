import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { resolveActiveMembership } from "./lib/organization-helpers";

/**
 * The active organization of a session, for HTTP handlers.
 *
 * `getCurrentUserInternal` only reads the session when it is handed a query
 * context, so from an HTTP action `user.activeOrganization` is always null. This
 * reads the session row directly, with the same membership re-check the cRPC
 * user gets (`resolveActiveMembership`).
 */
export const getActiveOrganizationIdForSession = internalQuery
    .input({ sessionId: v.string(), userId: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { sessionId, userId }, ctx }) => {
        const membership = await resolveActiveMembership(ctx, await ctx.db.session.findFirst({ where: { _id: sessionId as Id<"session"> } }), userId);

        return membership?.organizationId ?? null;
    });
