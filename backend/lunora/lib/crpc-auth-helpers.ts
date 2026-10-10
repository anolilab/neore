/**
 * cRPC Auth Helpers
 *
 * Helper functions for authentication in cRPC procedures.
 * Uses shared identity helpers for improved performance.
 * Includes ban enforcement for user access control.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "../_generated/server";
import { resolveActiveMembership } from "../auth/lib/organization-helpers";
import { resolveUserPlan } from "../auth/lib/plan";
import { getAuthUserIdentity, getSession } from "../auth/session";
import type { SessionUser } from "./auth-types";
import isBetterAuthUser from "./auth-types";

/**
 * Check if a user is currently banned.
 * Returns ban info if banned, null if not banned.
 */
export const checkUserBanStatus = (
    userDocument: {
        banExpires?: number | null;
        banned?: boolean | null;
        banReason?: string | null;
    } | null,
): { expiresAt?: number; isBanned: boolean; reason?: string } | null => {
    if (!userDocument?.banned) {
        return null;
    }

    // Check if ban has expired
    if (userDocument.banExpires && userDocument.banExpires < Date.now()) {
        return null; // Ban has expired
    }

    return {
        expiresAt: userDocument.banExpires || undefined,
        isBanned: true,
        reason: userDocument.banReason || undefined,
    };
};

/**
 * Throw error if user is banned.
 * Used in auth middleware to block banned users.
 */
export const enforceBanStatus = (banStatus: { expiresAt?: number; isBanned: boolean; reason?: string } | null): void => {
    if (banStatus?.isBanned) {
        throw new LunoraError("FORBIDDEN", banStatus.reason || "Your account has been suspended");
    }
};

// isBetterAuthUser is imported from ./authTypes

/**
 * Build SessionUser from Better Auth user object.
 */
export const buildSessionUser = (user: unknown): SessionUser | null => {
    if (!isBetterAuthUser(user)) {
        return null;
    }

    const userId = user._id;

    if (!userId) {
        return null;
    }

    const activeOrg = user.activeOrganization;

    return {
        activeOrganization: activeOrg
            ? {
                  id: activeOrg.id,
                  name: activeOrg.name,
                  role: activeOrg.role || "member",
                  slug: activeOrg.slug || null,
              }
            : null,
        email: user.email || "",
        image: user.image,
        impersonatedBy: user.impersonatedBy || null,
        isAdmin: user.role === "admin",
        name: user.name || "",
        plan: user.plan ?? null,
        role: user.role || null,
        userId,
    };
};

/**
 * Build SessionUser from the identity.
 * This is the fast path using getAuthUserIdentity.
 */
export const buildSessionUserFromIdentity = (
    identity: {
        email?: string;
        name?: string;
        pictureUrl?: string;
        sessionId: string;
        subject: string;
        userId: string;
    },
    session?: {
        activeOrganizationId?: string | null;
        impersonatedBy?: string | null;
    } | null,
    organization?: {
        id: string;
        name: string;
        role: string;
        slug: string | null;
    } | null,
): SessionUser => {
    const userId = identity.userId as string;

    return {
        activeOrganization: organization || null,
        email: identity.email || "",
        image: identity.pictureUrl || null,
        impersonatedBy: session?.impersonatedBy || null,
        isAdmin: false, // Will be determined from user doc if needed
        name: identity.name || "",
        role: null, // Will be determined from user doc if needed
        userId,
    };
};

/**
 * Get session user for QUERIES (read operations).
 * Uses getAuthUserIdentity for optimal performance.
 * Optimized to run queries in parallel where possible.
 * Enforces ban status - throws if user is banned.
 */
export const getSessionUserForQuery = async (context: QueryContext, options?: { skipBanCheck?: boolean }): Promise<SessionUser | null> => {
    // Use getAuthUserIdentity for fast identity lookup
    const identity = await getAuthUserIdentity(context);

    if (!identity) {
        return null;
    }

    // Run session lookup and user doc lookup in parallel
    const [session, userDocument] = await Promise.all([
        getSession(context, identity.sessionId),
        // `findFirst` on `_id`, not `get`: a `get` of a `.global()` id probes
        // every global table (root AGENTS.md, "Database access").
        context.db.user.findFirst({ where: { _id: identity.userId as Id<"user"> } }),
    ]);

    // Enforce ban status unless explicitly skipped (e.g., for admin operations)
    if (!options?.skipBanCheck) {
        const banStatus = checkUserBanStatus(userDocument);

        enforceBanStatus(banStatus);
    }

    const userRole = userDocument?.role ?? null;

    // Build basic session user from identity
    let activeOrganization = null;
    let paidOrganization = null;

    if (session?.activeOrganizationId) {
        // Fetch organization and membership in parallel. No membership, no
        // organization context: the session outlives a revoked membership.
        const [org, membership] = await Promise.all([
            context.db.organization.findFirst({ where: { _id: context.db.asId("organization", session.activeOrganizationId) } }),
            resolveActiveMembership(context, session, identity.userId as string),
        ]);

        if (org && membership) {
            activeOrganization = {
                id: org._id,
                name: org.name,
                role: membership.role,
                slug: org.slug ?? null,
            };
            paidOrganization = org;
        }
    }

    return {
        activeOrganization,
        email: identity.email || "",
        image: identity.pictureUrl || null,
        impersonatedBy: session?.impersonatedBy || null,
        isAdmin: userRole === "admin",
        name: identity.name || "",
        plan: resolveUserPlan(userDocument, [paidOrganization]),
        role: userRole || null,
        userId: identity.userId as string,
    };
};

// Request-level cache for JWT identity to avoid repeated validation overhead
// This cache is per-request (per-query execution) and gets GC'd after the query completes
const identityCache = new WeakMap<QueryContext, Awaited<ReturnType<typeof getAuthUserIdentity>>>();

/**
 * LIGHTWEIGHT auth for read-only queries (60-80% faster than full auth).
 *
 * Use this for queries that:
 * - Only need userId for filtering (listThreads, getThread, etc.)
 * - Don't need ban checking (read operations don't require ban enforcement)
 * - Don't need organization context
 *
 * Saves 200-400ms per query by skipping:
 * - Session DB lookup
 * - User doc DB lookup (ban check)
 * - Organization + membership lookups
 *
 * Total DB reads: 0 (uses cached JWT identity only)
 * vs. full auth: 2-4 DB reads
 *
 * OPTIMIZATION: Caches JWT identity per-request to avoid repeated validation.
 */
export const getSessionUserForQueryLite = async (context: QueryContext): Promise<SessionUser | null> => {
    // Check cache first to avoid repeated JWT validation (saves 50-100ms on cache hit)
    let identity = identityCache.get(context);

    if (!identity) {
        // Only fetch JWT identity - no DB lookups!
        identity = await getAuthUserIdentity(context);

        if (identity) {
            // Cache for this request
            identityCache.set(context, identity);
        }
    }

    if (!identity) {
        return null;
    }

    // Return minimal session user from JWT only
    return {
        activeOrganization: null,
        email: identity.email || "",
        image: identity.pictureUrl || null,
        impersonatedBy: null,
        isAdmin: false, // Assume not admin for read queries
        name: identity.name || "",
        role: null,
        userId: identity.userId as string,
    };
};

/**
 * Get session user for MUTATIONS (write operations).
 * Uses getAuthUserIdentity for consistency with queries.
 * Enforces ban status - throws if user is banned.
 */
export const getSessionUser = async (context: MutationContext, options?: { skipBanCheck?: boolean }): Promise<SessionUser | null> =>
    // Use the same implementation as queries for consistency
    getSessionUserForQuery(context, options);

/**
 * Get session user with anonymous support for MUTATIONS.
 * Enforces ban status - throws if user is banned.
 */
export const getSessionUserWithAnonymous = async (
    context: MutationContext,
    _shouldAllowAnonymous: boolean,
    options?: { skipBanCheck?: boolean },
): Promise<SessionUser | null> =>
    // getAuthUserIdentity already handles anonymous users
    getSessionUser(context, options);

/**
 * Get session user with anonymous support for QUERIES.
 * Enforces ban status - throws if user is banned.
 */
export const getSessionUserWithAnonymousForQuery = async (
    context: QueryContext,
    _shouldAllowAnonymous: boolean,
    options?: { skipBanCheck?: boolean },
): Promise<SessionUser | null> => getSessionUserForQuery(context, options);

/** The default rejection when a caller that must be signed in is not. */
const AUTH_REQUIRED_ERROR: { code: "UNAUTHORIZED"; message: string } = { code: "UNAUTHORIZED", message: "Not authenticated" };

/**
 * Validate and process user for auth context.
 */
export const validateAuthUser = (
    user: SessionUser | null,
    shouldAllowAnonymous: boolean,
    role?: "admin",
    error: { code: "UNAUTHORIZED"; message: string } = AUTH_REQUIRED_ERROR,
): SessionUser => {
    if (!shouldAllowAnonymous) {
        if (!user) {
            // `(code, message)` positionally. The earlier error class took an options object,
            // so this was passing the whole object as the CODE.
            throw new LunoraError(error.code, error.message);
        }

        return user;
    }

    if (!user) {
        throw new LunoraError("UNAUTHORIZED", "Please sign in (even anonymously) to continue");
    }

    if (role === "admin" && !user.isAdmin) {
        throw new LunoraError("FORBIDDEN", "Admin access required");
    }

    return user;
};

// Re-export identity helpers for convenience

export { getAuthUserId, getAuthUserIdentity, getSession } from "../auth/session";
