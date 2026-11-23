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
 * never refills it. Once every slot of a cohort is taken (`sealedCohortsOf`), the organization view shows the cohort with the members it has.
 */
import type { MutationCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";

export const COHORT_SIZE = 5;

/** How many times a booking reads again after losing a slot to another booking. Past this, the booking fails and is retried by its caller. */
const MAX_SLOT_TRIES = 8;

/** Pure: the cohort the booking that claimed `slot` (0 for the first) is placed in. */
export const cohortOfBooking = (slot: number): number => Math.floor(slot / COHORT_SIZE);

/**
 * Pure: how many cohorts, from cohort 0, have every booking slot taken when `topSlot` is the highest slot claimed (`undefined` for none). A
 * new booking only ever takes the slot after the top one, so such a cohort never gains a member: one that lost a member stays short for good.
 */
export const sealedCohortsOf = (topSlot: number | undefined): number => (topSlot === undefined ? 0 : Math.floor((topSlot + 1) / COHORT_SIZE));

/**
 * How long after its claim a slot counts towards sealing a cohort. The claim and the contributor row are separate writes, so a view that
 * read a just-claimed slot could miss its member; by this time the row has landed, or the claim was released.
 */
export const SLOT_SETTLE_MS = 5 * 60 * 1000;

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
            const claim = await ctx.db.insert("usageOrganizationCohortSlots", { claimedAt: ctx.now, organizationId, slot });

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
 * a release that fails too leaves the hole: a slot no member ever held, so the cohort shows with the members it has once it is sealed. A
 * member already booked (two first replies at once) keeps their one entry: the unique `(organizationId, userId)` index refuses a second, and
 * the booking returns without one, so a member is never in two cohorts.
 */
export const insertContributor = async (ctx: MutationCtx, row: { createdAt: number; organizationId: string; userId: string }): Promise<void> => {
    // A guest whose entry a merge handed to their new account (`lib/account-merge.ts#handOverOrganizationContributors`) still has rows
    // on their own shard until the merge deletes them: booked again, those rows would count in a second cohort.
    const handedOver = await ctx.db.usageOrganizationContributors.findFirst({
        consistency: "primary",
        where: { mergedFrom: row.userId, organizationId: row.organizationId },
    });

    if (handedOver) {
        return;
    }

    const { claim, cohort } = await claimSlot(ctx, row.organizationId);

    try {
        await ctx.db.insert("usageOrganizationContributors", { ...row, cohort });
    } catch (error) {
        try {
            await ctx.db.delete("usageOrganizationCohortSlots", claim);
        } catch {
            // The claim stays: a hole in its cohort that no member held.
        }

        if (isUniqueViolation(error)) {
            return;
        }

        throw error;
    }
};
