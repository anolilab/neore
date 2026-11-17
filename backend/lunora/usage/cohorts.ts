/**
 * Stable cohorts for the organization usage view (`usage/organization.ts`).
 *
 * Each contributor is booked into a cohort of {@link COHORT_SIZE}, in booking order, and keeps that cohort. A cohort's members are fixed once
 * the next cohort opens, so a contributor who starts recording later can never move into, or out of, a group the view has already released.
 *
 * Each booking claims the next slot under its organization (`usageOrganizationCohortSlots`), and takes cohort `slot / COHORT_SIZE`. The slot's
 * unique key is the claim: two bookings that read the same top slot both insert the same next one, the database accepts one, and the other
 * reads again and takes the slot after. So every slot is taken once, and no cohort gains a member after the next one has opened. Slots are
 * never reused, even when a contributor's entry is removed, so a removal leaves a cohort short but never refills it.
 */
import type { MutationCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";

export const COHORT_SIZE = 5;

/** How many times a booking reads again after losing a slot to another booking. Past this, the booking fails and is retried by its caller. */
const MAX_SLOT_TRIES = 8;

/** Pure: the cohort the booking that claimed `slot` (0 for the first) is placed in. */
export const cohortOfBooking = (slot: number): number => Math.floor(slot / COHORT_SIZE);

/**
 * Claims the next booking slot under an organization and returns its cohort. Runs in the caller's mutation, so the contributor row written next
 * carries the cohort of the slot it claimed.
 */
export const allocateCohort = async (ctx: MutationCtx, organizationId: string): Promise<number> => {
    for (let attempt = 1; ; attempt += 1) {
        const top = await ctx.db.usageOrganizationCohortSlots.findFirst({
            consistency: "primary",
            orderBy: [{ slot: "desc" }],
            where: { organizationId },
        });
        const slot = (top?.slot ?? -1) + 1;

        try {
            await ctx.db.insert("usageOrganizationCohortSlots", { organizationId, slot });

            return cohortOfBooking(slot);
        } catch (error) {
            if (!isUniqueViolation(error) || attempt >= MAX_SLOT_TRIES) {
                throw error;
            }
        }
    }
};
