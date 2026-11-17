/**
 * Stable cohorts for the organization usage view (`usage/organization.ts`).
 *
 * Each contributor is booked into a cohort of {@link COHORT_SIZE}, in booking order, and keeps that cohort. A cohort's members are fixed once
 * the next cohort opens, so a contributor who starts recording later can never move into, or out of, a group the view has already released.
 *
 * Each booking claims the next slot under its organization (`usageOrganizationCohortSlots`), and takes cohort `slot / COHORT_SIZE`. The slot's
 * unique key is the claim: two bookings that read the same top slot both insert the same next one, the database accepts one, and the other
 * reads again and takes the slot after. So every slot is taken once, and no cohort gains a member after the next one has opened.
 *
 * The slot and the contributor row are separate writes. If the contributor row fails after the slot is claimed, the slot is released, so no
 * cohort is left short of a member it can never get. Slots are never reused otherwise, so a contributor's removal leaves a cohort short but
 * never refills it.
 */
import type { MutationCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";

export const COHORT_SIZE = 5;

/** How many times a booking reads again after losing a slot to another booking. Past this, the booking fails and is retried by its caller. */
const MAX_SLOT_TRIES = 8;

/** Pure: the cohort the booking that claimed `slot` (0 for the first) is placed in. */
export const cohortOfBooking = (slot: number): number => Math.floor(slot / COHORT_SIZE);

/**
 * Claims the next booking slot under an organization. Returns the cohort it falls in and the claim's row, so a failed contributor row can
 * release it.
 */
const claimSlot = async (ctx: MutationCtx, organizationId: string) => {
    for (let attempt = 1; ; attempt += 1) {
        const top = await ctx.db.usageOrganizationCohortSlots.findFirst({
            consistency: "primary",
            orderBy: [{ slot: "desc" }],
            where: { organizationId },
        });
        const slot = (top?.slot ?? -1) + 1;

        try {
            const claim = await ctx.db.insert("usageOrganizationCohortSlots", { organizationId, slot });

            return { claim, cohort: cohortOfBooking(slot) };
        } catch (error) {
            if (!isUniqueViolation(error) || attempt >= MAX_SLOT_TRIES) {
                throw error;
            }
        }
    }
};

/** Claims the next booking slot under an organization and returns its cohort. */
export const allocateCohort = async (ctx: MutationCtx, organizationId: string): Promise<number> => {
    const { cohort } = await claimSlot(ctx, organizationId);

    return cohort;
};

/**
 * Books a contributor into the next slot's cohort. If the contributor row fails, the slot is released, so it leaves no hole in its cohort;
 * a release that fails too leaves the hole, which only withholds that cohort's totals.
 */
export const insertContributor = async (ctx: MutationCtx, row: { createdAt: number; organizationId: string; userId: string }): Promise<void> => {
    const { claim, cohort } = await claimSlot(ctx, row.organizationId);

    try {
        await ctx.db.insert("usageOrganizationContributors", { ...row, cohort });
    } catch (error) {
        try {
            await ctx.db.delete("usageOrganizationCohortSlots", claim);
        } catch {
            // The claim stays: its cohort is short by this member, which withholds that cohort rather than exposing it.
        }

        throw error;
    }
};
