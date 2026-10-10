import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Doc } from "../../_generated/dataModel";
import type { ActionCtx as ActionContext, QueryCtx as QueryContext } from "../../_generated/server";
import { authLogger } from "../../lib/logger";
import { type AuthUserIdentity, getAuthUserIdentity, getSession } from "../session";
import { getMemberByOrganizationAndUser, getOrganization, getUser } from "./better-auth-queries";
import { resolveUserPlan, type UserPlan } from "./plan";
import type { BetterAuthUser } from "./types";

/**
 * Type guard to check if context is a QueryContext (has db property).
 */
const isQueryContext = (context: HttpActionCtx | QueryContext | ActionContext): context is QueryContext => "db" in context && context.db !== undefined;

export interface OrganizationContext {
    organizationId?: string;
    role?: string;
    userId: string;
}

/**
 * Get the current user's ID from the Better Auth context.
 * Throws an error if no user is authenticated.
 */
export const requireUserId = async (context: QueryContext | ActionContext): Promise<string> => {
    const identity = await getAuthUserIdentity(context as QueryContext);

    if (!identity) {
        throw new Error("Authentication required");
    }

    return identity.userId as string;
};

/**
 * Get the current user with organization context from Better Auth.
 * Returns user data including active organization information.
 */
export const getCurrentUserWithOrganization = async (context: QueryContext): Promise<OrganizationContext | null> => {
    const identity = await getAuthUserIdentity(context);

    if (!identity) {
        return null;
    }

    const userId = identity.userId as string;

    // Get session for active organization info (only if sessionId is available)
    let session: Awaited<ReturnType<typeof getSession>> | null = null;

    if (identity.sessionId) {
        try {
            session = await getSession(context);
        } catch (error) {
            authLogger.warn("[getCurrentUserWithOrganization] Failed to get session:", error);
        }
    }

    const activeOrgId = session?.activeOrganizationId as string | null | undefined;

    let role: string | undefined;

    if (activeOrgId) {
        // Get user's role in the organization
        const membership = await getMemberByOrganizationAndUser(context, activeOrgId, userId);

        role = membership?.role || undefined;
    }

    return {
        organizationId: activeOrgId || undefined,
        role,
        userId,
    };
};

/**
 * Get the current user for internal use.
 * Uses getAuthUserIdentity for optimal performance.
 * Supports both QueryContext and ActionContext.
 */

/**
 * `HttpActionCtx` is in the union because HTTP actions call this directly (5 sites
 * in `chat/http.ts` alone). The body already branches on `isQueryContext` and
 * falls back to `runQuery`, which is exactly the surface an HTTP action has — so
 * this widens the accepted argument without widening what the function uses.
 */
/**
 * `getAuthUserIdentity` for a context without `db` (HTTP actions, actions): the
 * user id and session id come from `context.auth`, the profile from a query.
 */
const getIdentityWithoutDb = async (context: HttpActionCtx | ActionContext): Promise<AuthUserIdentity | null> => {
    const userId = context.auth.userId as string | null | undefined;

    if (!userId) {
        return null;
    }

    const profile = await context.runQuery(internal.auth.identity.getUserProfileForIdentity, { userId });

    if (!profile) {
        return null;
    }

    const authIdentity = await context.auth.getIdentity();

    return {
        email: profile.email,
        name: profile.name,
        pictureUrl: profile.image,
        sessionId: authIdentity?.sessionId as AuthUserIdentity["sessionId"],
        subject: userId,
        userId: userId as AuthUserIdentity["userId"],
    };
};

export const getCurrentUserInternal = async (context: HttpActionCtx | QueryContext | ActionContext): Promise<BetterAuthUser | undefined> => {
    const identity = isQueryContext(context) ? await getAuthUserIdentity(context) : await getIdentityWithoutDb(context);

    if (!identity) {
        return undefined;
    }

    // Get session for additional data (only if sessionId is available and we have a QueryContext)
    let session: Awaited<ReturnType<typeof getSession>> | null = null;

    if (identity.sessionId && isQueryContext(context)) {
        try {
            session = await getSession(context);
        } catch (error) {
            authLogger.warn("[getCurrentUserInternal] Failed to get session:", error);
        }
    }

    const activeOrgId = session?.activeOrganizationId as string | null | undefined;

    let activeOrganization: BetterAuthUser["activeOrganization"] = null;
    let paidOrganization: Doc<"organization"> | null = null;

    if (activeOrgId) {
        if (isQueryContext(context)) {
            // QueryContext - use db directly
            const org = await getOrganization(context, activeOrgId);

            if (org) {
                const membership = await getMemberByOrganizationAndUser(context, activeOrgId, identity.userId as string);

                // No membership row, no org context (see `getActiveOrganizationQuery`).
                activeOrganization = membership
                    ? {
                          id: org._id,
                          name: org.name,
                          role: membership.role,
                          slug: org.slug ?? null,
                      }
                    : null;
                paidOrganization = membership ? org : null;
            }
        } else {
            // ActionContext - use runQuery
            activeOrganization = await context.runQuery(internal.auth.functions.getActiveOrganizationQuery, {
                organizationId: activeOrgId,
                userId: identity.userId as string,
            });
        }
    }

    // `role` and `isAnonymous` come from the user ROW: the identity carries
    // neither, and HTTP routes gate the guest model, guest quota and admin
    // exemptions on them. Left `null`/absent, every guest read as a free user.
    // `plan` likewise: from a query context, off the user row and the active
    // organization read above; otherwise the flags query resolves both itself
    // (`auth/lib/plan.ts`).
    let flags: { isAnonymous: boolean; plan: UserPlan; role: string | null };

    if (isQueryContext(context)) {
        const row = await getUser(context, identity.userId as string);

        flags = { isAnonymous: row?.isAnonymous === true, plan: resolveUserPlan(row, [paidOrganization]), role: row?.role ?? null };
    } else {
        flags = await context.runQuery(internal.auth.functions.getUserAuthFlagsQuery, {
            ...(identity.sessionId && { sessionId: identity.sessionId as string }),
            userId: identity.userId as string,
        });
    }

    // Build BetterAuthUser from identity
    const user: BetterAuthUser = {
        _id: identity.userId as string,
        activeOrganization,
        email: identity.email || "",
        image: identity.pictureUrl || null,
        isAnonymous: flags.isAnonymous,
        name: identity.name || "",
        plan: flags.plan,
        role: flags.role,
    };

    return user;
};
