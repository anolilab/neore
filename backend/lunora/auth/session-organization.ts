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

/**
 * The same read for a caller whose cap must fail closed (the MCP app proxy): `null` when the session cannot be
 * validated (missing, another user's, or expired), so the caller can cap it at `ask` rather than read it as the personal
 * space. A valid session gives its verified active organization, or `null` for the personal space.
 */
export const getSessionOrganizationForCap = internalQuery
    .input({ sessionId: v.string(), userId: v.string() })
    .output(v.union(v.object({ organizationId: v.union(v.string(), v.null()) }), v.null()))
    .query(async ({ args: { sessionId, userId }, ctx }) => {
        const session = await ctx.db.session.findFirst({ where: { _id: sessionId as Id<"session"> } });

        // `ctx.now`, not the wall clock: a query re-run on the same data must give the same answer.
        if (!session || session.userId !== userId || session.expiresAt <= ctx.now) {
            return null;
        }

        const membership = await resolveActiveMembership(ctx, session, userId);

        return { organizationId: membership?.organizationId ?? null };
    });
