import type { Doc, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../../_generated/server";
import { throwForbidden, throwNotFound, throwUnauthorized } from "../../lib/error-helpers";
import { getMemberByOrganizationAndUser, getOrganization } from "./better-auth-queries";

/**
 * Validates that a user has access to an organization and optionally checks for specific permissions.
 * Throws an error if access is denied.
 * Optimized: Performs fast checks first before any DB queries.
 * @param context The query or mutation context with user information
 * @param organizationId The ID of the organization to check access for
 * @param _requiredPermissions Optional permissions to check (e.g., { organization: ["update"] })
 * @throws {LunoraError} If the user does not have access or required permissions
 */
export const validateOrganizationAccess = async (
    context: (QueryContext | MutationContext) & { user: { activeOrganization?: { id: string } | null; userId: string } },
    organizationId: string,
    _requiredPermissions?: { invitation?: string[]; member?: string[]; organization?: string[] },
): Promise<void> => {
    // Fast path: Check in-memory data first (no DB queries)
    const activeOrgId = context.user.activeOrganization?.id;

    if (!activeOrgId) {
        throwUnauthorized("No active organization");
    }

    if (activeOrgId !== organizationId) {
        throwForbidden("You do not have access to this organization");
    }

    // Slow path: DB queries only when needed
    // Fetch org and member in parallel to reduce latency
    const [org, member] = await Promise.all([
        getOrganization(context, organizationId),
        getMemberByOrganizationAndUser(context, organizationId, context.user.userId),
    ]);

    if (!org) {
        throwNotFound("Organization");
    }

    if (!member) {
        throwForbidden("You are not a member of this organization");
    }

    // Note: requiredPermissions is no longer validated here as hasPermission needs
    // AuthMutationContext. Callers should validate permissions separately if needed.
};

/**
 * Checks if a user is the owner of an organization.
 * Optimized: Only fetches member if ownerId check fails.
 * @param context The query or mutation context with user information
 * @param organizationId The ID of the organization to check
 * @param org Optional pre-fetched organization to avoid redundant DB query
 * @returns True if the user is the owner, false otherwise
 */
export const isOrganizationOwner = async (
    context: (QueryContext | MutationContext) & { user: { userId: string } },
    organizationId: string,
    org?: { ownerId?: string | null } | null,
): Promise<boolean> => {
    // Use pre-fetched org if available, otherwise fetch it
    const organization = org ?? (await getOrganization(context, organizationId));

    if (!organization) {
        return false;
    }

    // Fast path: Check ownerId field first (no additional DB query)
    if (organization.ownerId && organization.ownerId === context.user.userId) {
        return true;
    }

    // Slow path: Fallback to member table only if ownerId not set
    const member = await getMemberByOrganizationAndUser(context, organizationId, context.user.userId);

    return member?.role === "owner";
};

/**
 * The caller's membership in a session's active organization, or `null`.
 *
 * `session.activeOrganizationId` alone proves nothing: a session keeps it after
 * the membership is revoked. So the session must belong to `userId` and be
 * unexpired, and the user must STILL be a member. Every place that turns a
 * session into organization context goes through this — the cRPC user and the
 * HTTP chat path alike.
 */
export const resolveActiveMembership = async (
    context: QueryContext | MutationContext,
    session: Pick<Doc<"session">, "activeOrganizationId" | "expiresAt" | "userId"> | null,
    userId: string,
): Promise<Doc<"member"> | null> => {
    if (!session || session.userId !== userId || session.expiresAt <= Date.now() || !session.activeOrganizationId) {
        return null;
    }

    return await getMemberByOrganizationAndUser(context, session.activeOrganizationId, userId);
};

/**
 * An `organizationId` a client asks to WRITE onto a row must be the caller's
 * active organization — which `ctx.user` only carries after
 * `resolveActiveMembership` proved the membership. `undefined` passes (the row
 * is personal). Anything else would plant a row in a stranger's organization,
 * where every member's org-scoped listing then shows it.
 */
export const assertOwnOrganizationId = (user: { activeOrganization?: { id: string } | null }, organizationId: string | null | undefined): void => {
    if (organizationId && organizationId !== user.activeOrganization?.id) {
        throwForbidden("You do not have access to this organization");
    }
};
