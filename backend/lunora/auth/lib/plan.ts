/**
 * A user's PLAN, as the rate limiter and the daily limits read it
 * (`getUserTier`, `dailyLimitTierOf`).
 *
 * Two things make a user premium: their OWN Pro subscription (`user.baseTier`,
 * bought per user through `billing/`), or an organization of theirs on a paid
 * tier (`organization.baseTier` — Team through `billing/`, or set by a platform
 * admin via `auth_billing.setOrganizationBillingTier`). Which organizations
 * count is the caller's decision: the session's ACTIVE one for a request, every
 * membership for a run with no session.
 */
import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { getMembersByUserId, getOrganization, getUser } from "./better-auth-queries";

export type UserPlan = "premium" | null;

const isPaidOrganization = (organization: Pick<Doc<"organization">, "baseTier"> | null | undefined): boolean =>
    organization?.baseTier === "pro" || organization?.baseTier === "enterprise";

export const resolveUserPlan = (
    user: Pick<Doc<"user">, "baseTier"> | null | undefined,
    organizations: ReadonlyArray<Pick<Doc<"organization">, "baseTier"> | null | undefined>,
): UserPlan => (user?.baseTier === "pro" || organizations.some((organization) => isPaidOrganization(organization)) ? "premium" : null);

/** The plan behind `getUserRunPlanQuery`, readable from a mutation's db too: every membership counts, as for a run. */
export const readUserRunPlan = async (context: QueryCtx, userId: string): Promise<{ isAdmin: boolean; plan: UserPlan }> => {
    const [user, memberships] = await Promise.all([getUser(context, userId), getMembersByUserId(context, userId)]);
    const organizations = await Promise.all(memberships.map(async (membership) => await getOrganization(context, membership.organizationId)));

    return {
        isAdmin: user?.role === "admin",
        plan: resolveUserPlan(user, organizations),
    };
};
