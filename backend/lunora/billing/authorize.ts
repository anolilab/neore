import type { PaymentsFromContextOptions } from "@lunora/payment";

/**
 * Whether `caller` may bill `referenceId` through `ctx.payments`: their own user id (Pro), or an
 * organization they own (Team). The role is read from the `member` row, not the session, so a
 * demoted owner loses access at once. Calls with no signed-in caller (the seat job, the deletion
 * step) and the portal go through `lunora/billing/provider.ts` behind their own checks instead.
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
