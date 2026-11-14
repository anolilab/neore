import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { getMemberByOrganizationAndUser } from "./lib/better-auth-queries";
import { MAX_LENGTH } from "../lib/validators";
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
 * The same read for a caller whose cap must fail closed (`/chat/start`, the MCP app proxy): `null` when the session
 * cannot be validated (missing, another user's, or expired), so the caller refuses it rather than read it as the
 * personal space. A valid session gives its verified active organization, or `null` for the personal space, which is
 * also what a session still naming an organization its user has left gives, as everywhere else in the app.
 */
export const getSessionOrganizationForCap = internalQuery
    // The session id comes from the request's sign-in, so it is bounded like every other id a request carries.
    .input({ sessionId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ impersonating: v.optional(v.boolean()), organizationId: v.union(v.string(), v.null()) }), v.null()))
    .query(async ({ args: { sessionId, userId }, ctx }) => {
        // Both reads from the primary: a replica can still hold a session just signed out or a membership just revoked.
        const session = await ctx.db.session.findFirst({ consistency: "primary", where: { _id: sessionId as Id<"session"> } });

        // `ctx.now`, not the wall clock: a query re-run on the same data must give the same answer.
        if (!session || session.userId !== userId || session.expiresAt <= ctx.now) {
            return null;
        }

        // Set when an admin opened this session to act as the user, for the writes refused to them (a guest note's send).
        const impersonating = session.impersonatedBy ? { impersonating: true } : {};

        if (!session.activeOrganizationId) {
            return { ...impersonating, organizationId: null };
        }

        // Membership is read directly, not through `resolveActiveMembership`: that helper checks expiry again with the
        // wall clock, so a session expiring between the two checks would read as the personal space and be uncapped.
        // A session that still names an organization its user has left (nothing clears the field on removal) is in the
        // personal space, as `crpc-auth-helpers` reads it: refusing it would lock a removed member out until they switch
        // spaces. A chat filed under that organization is still capped by it (the thread's own organization wins).
        const membership = await getMemberByOrganizationAndUser(ctx, session.activeOrganizationId, userId, "primary");

        return { ...impersonating, organizationId: membership ? session.activeOrganizationId : null };
    });
