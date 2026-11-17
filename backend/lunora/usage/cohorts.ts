/**
 * Stable cohorts for the organization usage view (`usage/organization.ts`).
 *
 * Each contributor is booked into a cohort of {@link COHORT_SIZE}, in the order they are booked, and keeps that cohort. A cohort's members
 * are fixed once the next cohort opens, so a contributor who starts recording later can never move into, or out of, a group the view has
 * already released. The organization's counter (`usageOrganizationCohorts`) counts the bookings: the next contributor takes cohort
 * `booked / COHORT_SIZE`.
 *
 * The counter is read and then written, so two bookings racing for one organization can take the same number. Then a cohort holds one
 * member too many or too few, and the walk releases a group with fewer than {@link COHORT_SIZE} members only when none was active
 * (`pageWithheld`). The members of a cohort still never change once booked, which is what the walk relies on.
 */
import type { MutationCtx } from "../_generated/server";

export const COHORT_SIZE = 5;

/** Pure: the cohort the booking with this number (0 for the first) is placed in. */
export const cohortOfBooking = (booked: number): number => Math.floor(booked / COHORT_SIZE);

/**
 * Books the next place under an organization and returns the cohort it falls in. Runs in the caller's mutation, so the contributor row
 * written next carries the cohort the counter gave it.
 */
export const allocateCohort = async (ctx: MutationCtx, organizationId: string): Promise<number> => {
    const counter = await ctx.db.usageOrganizationCohorts.findFirst({ consistency: "primary", where: { organizationId } });

    if (!counter) {
        await ctx.db.insert("usageOrganizationCohorts", { booked: 1, organizationId });

        return cohortOfBooking(0);
    }

    await ctx.db.patch("usageOrganizationCohorts", counter._id, { booked: counter.booked + 1 });

    return cohortOfBooking(counter.booked);
};
