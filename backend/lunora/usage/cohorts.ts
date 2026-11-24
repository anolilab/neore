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
 * The slot and the contributor row are separate writes. A slot counts as filled only once its contributor row has landed and the slot is
 * marked (`filled`). If the contributor row fails, the slot is released, so a booking that comes next can take it; one claimed after it
 * already has taken the next slot, and the released one stays a gap no member ever held. Slots are never reused otherwise, so a
 * contributor's removal leaves a cohort short but never refills it. A cohort is sealed (`sealedCohortsOf`) only when each of its slots was
 * filled: then it once had all its members, and the organization view shows it with the members it has. A gap, or a mark that failed,
 * leaves the cohort unsealed for good, so it shows only with five active members.
 */
import type { MutationCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";

export const COHORT_SIZE = 5;

/** How many times a booking reads again after losing a slot to another booking. Past this, the booking fails and is retried by its caller. */
const MAX_SLOT_TRIES = 8;

/** Pure: the cohort the booking that claimed `slot` (0 for the first) is placed in. */
export const cohortOfBooking = (slot: number): number => Math.floor(slot / COHORT_SIZE);

/**
 * Pure: the cohorts each of whose {@link COHORT_SIZE} booking slots is among `filledSlots` (the slots whose member's row landed). Such a
 * cohort once had every member, and a new booking only ever takes a slot after the top one, so it never gains a member: one that lost a
 * member stays short for good. A cohort with a slot never filled (a released claim another booking had already passed) is not sealed: it
 * never had five members.
 */
export const sealedCohortsOf = (filledSlots: Iterable<number>): number[] => {
    const filled = new Map<number, Set<number>>();

    for (const slot of filledSlots) {
        const cohort = cohortOfBooking(slot);
        const slots = filled.get(cohort) ?? new Set<number>();

        slots.add(slot);
        filled.set(cohort, slots);
    }

    return [...filled].filter(([, slots]) => slots.size === COHORT_SIZE).map(([cohort]) => cohort);
};

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
 * Books a contributor into the next slot's cohort, and marks the slot filled once the contributor row has landed. If the contributor row
 * fails, the slot is released, so the next booking can take it; it stays unfilled either way, so its cohort is never sealed by a member it
 * never had. A member already booked (two first replies at once) keeps their one entry: the unique `(organizationId, userId)` index refuses a second, and
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
            // The claim stays, unfilled: its cohort is never sealed.
        }

        if (isUniqueViolation(error)) {
            return;
        }

        throw error;
    }

    try {
        await ctx.db.patch("usageOrganizationCohortSlots", claim, { filled: true });
    } catch {
        // The member is booked; the slot stays unfilled, so the cohort is never sealed and shows only with five active members.
    }
};
