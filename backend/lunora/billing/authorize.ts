import type { AuthorizeReference, PaymentsFromContextOptions } from "@lunora/payment";

import { billingOrganizationOf } from "./plans";

/**
 * Whether `caller` may bill `referenceId` through `ctx.payments`: their own user id (Pro), or an
 * organization they own (Team). The role is read from the `member` row, not the session, so a
 * demoted owner loses access at once. Calls with no signed-in caller (the seat job, the deletion
 * step) do not come through here: they scope the facade to the one reference they act for.
 */
export const authorizeBilling: NonNullable<PaymentsFromContextOptions["authorize"]> = async (referenceId, { db, userId }) => {
    if (userId === undefined) {
        return false;
    }

    if (referenceId === userId) {
        return true;
    }

    const membership = await db.findFirst("member", { where: { organizationId: referenceId, userId } });

    return membership?.["role"] === "owner";
};

/**
 * One reference the server has already decided is this call's subject: a queued job or a workflow
 * step with no caller, or a portal call after its gate. Allows that reference and nothing else, so
 * it never widens the facade's own rule.
 */
export const jobSubject =
    (referenceId: string): AuthorizeReference =>
    (candidate) =>
        candidate === referenceId;

/**
 * The active organization a Team action is for, when its signed-in caller owns it. Throws the same
 * way `billingOrganizationOf` does when they do not.
 */
export const ownedOrganizationReference = (user: Parameters<typeof billingOrganizationOf>[0]): AuthorizeReference => jobSubject(billingOrganizationOf(user));
